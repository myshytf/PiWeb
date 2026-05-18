/**
 * Service Worker for PiWeb PWA push notifications.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

const PENDING_SESSION_CACHE = "pi-web-notification-state";
const PENDING_SESSION_KEY = "/__pi-web-pending-session-open";

async function persistPendingSessionOpen(payload) {
  try {
    if (!payload?.sessionFile) return;
    const cache = await caches.open(PENDING_SESSION_CACHE);
    await cache.put(
      PENDING_SESSION_KEY,
      new Response(JSON.stringify({ ...payload, createdAt: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch {
    /* CacheStorage can fail in private/limited modes; postMessage/URL remain fallbacks. */
  }
}

self.addEventListener("push", (event) => {
  // Parse payload or use defaults
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    /* ignore malformed payload */
  }

  const title = data.title || "PiWeb";
  const options = {
    body: data.body || "Agent task completed",
    icon: data.icon || "/icon-192.png",
    tag: data.tag || "PiWeb",
    data: data.data || { url: "/" },
  };

  event.waitUntil(
    (async () => {
      try {
        // Only show notification if no PWA window is focused.
        // If clients API is unavailable (e.g. iOS background), show it anyway.
        const clientList = await clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        if (clientList.some((c) => c.focused)) {
          return; // App is active — don't disturb
        }
      } catch {
        /* clients API not available — show notification */
      }
      return self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const notificationData = event.notification.data || {};
  const url = notificationData.url || "/";
  const targetUrl = new URL(url, self.location.origin).href;
  const sessionFile = notificationData.sessionFile || new URL(targetUrl).searchParams.get("session");

  const notifyClient = (client) => {
    try {
      client.postMessage({
        type: "pi-web-open-session",
        sessionFile,
        url: targetUrl,
        notificationData,
      });
    } catch {
      /* ignore */
    }
  };

  event.waitUntil(
    (async () => {
      await persistPendingSessionOpen({
        sessionFile,
        url: targetUrl,
        notificationData,
      });

      try {
        const clientList = await clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of clientList) {
          const sameOrigin = new URL(client.url).origin === self.location.origin;
          if (!sameOrigin) continue;

          // Navigate existing PWA window to the notification target session, then focus it.
          let targetClient = client;
          if ("navigate" in client && client.url !== targetUrl) {
            targetClient = (await client.navigate(targetUrl)) || client;
          }
          notifyClient(targetClient);
          await targetClient.focus();
          return;
        }
      } catch {
        /* clients API not available */
      }

      const openedClient = await clients.openWindow(targetUrl);
      if (openedClient) notifyClient(openedClient);
    })(),
  );
});
