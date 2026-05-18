/**
 * Push notification API routes.
 *
 * GET  /api/push/vapid-public-key  — returns the VAPID public key for subscription
 * POST /api/push/subscribe         — stores a push subscription
 * POST /api/push/unsubscribe       — removes a push subscription
 * POST /api/push/test              — sends a test push notification to all subscribers
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";

export function registerPushRoutes(app: Hono, piWebApp: PiWebApp) {
  app.get("/api/push/vapid-public-key", (c) => {
    const publicKey = piWebApp.pushManager.getVapidPublicKey();
    return c.json({ publicKey });
  });

  app.post("/api/push/subscribe", async (c) => {
    try {
      const body = await c.req.json();
      const { endpoint, keys, expirationTime } = body;

      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return c.json({ error: "Invalid subscription object" }, 400);
      }

      piWebApp.pushManager.addSubscription({
        endpoint,
        expirationTime: expirationTime ?? null,
        keys: {
          p256dh: keys.p256dh,
          auth: keys.auth,
        },
      });

      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
  });

  app.post("/api/push/unsubscribe", async (c) => {
    try {
      const body = await c.req.json();
      const { endpoint } = body;

      if (!endpoint) {
        return c.json({ error: "Missing endpoint" }, 400);
      }

      piWebApp.pushManager.removeSubscription(endpoint);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
  });

  app.post("/api/push/test", async (c) => {
    const count = piWebApp.pushManager.subscriptionCount;
    console.log(`[push] Sending test notification to ${count} subscriber(s)...`);
    try {
      const body = await c.req.json().catch(() => ({}));
      await piWebApp.pushManager.sendToAll({
        title: "pi-web-remote",
        body: body.message || "Test notification — agent task completed!",
        icon: "/icon-192.png",
        tag: "pi-web-remote",
        data: { url: "/" },
      });
      return c.json({ ok: true, sentTo: count });
    } catch (err) {
      console.error("[push] Test send error:", err);
      return c.json({ error: "Send failed" }, 500);
    }
  });
}
