/**
 * Push notification utilities for the frontend.
 *
 * Handles: Service Worker registration, Push subscription lifecycle,
 * notification permission management.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const res = await fetch(url, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch the server's VAPID public key (base64 URL-encoded). */
export async function getVapidPublicKey(): Promise<string> {
  const data = await fetchJson<{ publicKey: string }>(
    "/api/push/vapid-public-key",
  );
  return data.publicKey;
}

/** Register the service worker. Safe to call multiple times. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return null;
  }
  try {
    const registration =
      await navigator.serviceWorker.register("/service-worker.js");
    // Make service-worker fixes (notification click handling) roll out quickly.
    void registration.update().catch(() => {
      /* best effort */
    });
    return registration;
  } catch (err) {
    console.error("[push] SW registration failed:", err);
    return null;
  }
}

/**
 * Subscribe to push notifications using the given SW registration.
 * Returns null if subscription fails or is not supported.
 */
export async function subscribeToPush(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription | null> {
  try {
    // If there's already a subscription, reuse it
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing;

    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applicationServerKey: applicationServerKey as any,
    });
    return subscription;
  } catch (err) {
    console.error("[push] Subscribe failed:", err);
    return null;
  }
}

/** Send the push subscription object to the server for storage. */
export async function sendSubscriptionToServer(
  subscription: PushSubscription,
): Promise<boolean> {
  try {
    const sub = subscription.toJSON();
    await fetchJson("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    return true;
  } catch (err) {
    console.error("[push] Failed to send subscription to server:", err);
    return false;
  }
}

/** Fully unsubscribe from push (server + browser). */
export async function unsubscribeFromPush(): Promise<boolean> {
  try {
    if (!("serviceWorker" in navigator)) return false;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return true;

    // Notify server first
    const sub = subscription.toJSON();
    await fetchJson("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {
      /* best-effort */
    });

    await subscription.unsubscribe();
    return true;
  } catch (err) {
    console.error("[push] Unsubscribe failed:", err);
    return false;
  }
}

export type PushPermissionState =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

/** Get the current notification permission state. */
export function getPushPermissionState(): PushPermissionState {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Request notification permission (must be triggered by user gesture). */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

/**
 * Full setup: register SW → subscribe → send to server.
 * Only succeeds if Notification.permission is already "granted".
 */
export async function trySetupPushNotifications(): Promise<boolean> {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    console.warn("[push] Push not supported in this browser");
    return false;
  }
  if (Notification.permission !== "granted") {
    console.warn("[push] Notification permission not granted");
    return false;
  }

  try {
    const vapidPublicKey = await getVapidPublicKey();
    console.log("[push] Got VAPID public key");

    const registration = await registerServiceWorker();
    if (!registration) {
      console.error("[push] Failed to register service worker");
      return false;
    }
    console.log("[push] Service worker registered, state:", registration.active?.state);

    // Wait for the service worker to be active
    if (!registration.active || registration.active.state !== "activated") {
      console.log("[push] Waiting for service worker to activate...");
      await new Promise<void>((resolve, reject) => {
        const sw = registration.installing || registration.waiting || registration.active;
        if (sw && sw.state === "activated") return resolve();

        const onStateChange = () => {
          console.log("[push] Service worker state changed:", sw?.state);
          if (sw?.state === "activated") resolve();
        };

        if (sw && sw.state !== "redundant") {
          sw.addEventListener("statechange", onStateChange);
        } else {
          // No active/installing/waiting worker — might be activating already
          registration.addEventListener("updatefound", () => {
            const newSw = registration.installing;
            if (newSw) newSw.addEventListener("statechange", onStateChange);
          });
        }

        // Safety timeout
        setTimeout(() => {
          console.log("[push] SW activation wait timed out, proceeding anyway");
          resolve();
        }, 10_000);
      });
    }

    const subscription = await subscribeToPush(registration, vapidPublicKey);
    if (!subscription) {
      console.error("[push] Failed to subscribe to push");
      return false;
    }
    console.log("[push] Push subscription obtained");

    const sent = await sendSubscriptionToServer(subscription);
    if (!sent) {
      console.error("[push] Failed to send subscription to server");
      return false;
    }
    console.log("[push] Push setup complete and active");
    return true;
  } catch (err) {
    console.error("[push] Setup failed:", err);
    return false;
  }
}
