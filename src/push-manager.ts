/**
 * Push notification manager for pi-web-remote.
 *
 * Manages VAPID keys, push subscriptions, and sends notifications
 * via the Web Push API (Apple Push Notification Service).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import webpush from "web-push";

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

const PUSH_DIR = path.join(process.env.HOME || "/tmp", ".pi", "push");
const VAPID_KEYS_FILE = path.join(PUSH_DIR, "vapid-keys.json");
const SUBSCRIPTIONS_FILE = path.join(PUSH_DIR, "subscriptions.json");

export class PushManager {
  private subscriptions = new Map<string, PushSubscriptionData>();
  private vapidPublicKey = "";
  private vapidPrivateKey = "";
  private initialized = false;

  async init(): Promise<void> {
    fs.mkdirSync(PUSH_DIR, { recursive: true });

    // Load or generate VAPID keys
    if (fs.existsSync(VAPID_KEYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, "utf-8"));
      this.vapidPublicKey = data.publicKey;
      this.vapidPrivateKey = data.privateKey;
      console.log("[push] Loaded existing VAPID keys");
    } else {
      const vapidKeys = webpush.generateVAPIDKeys();
      this.vapidPublicKey = vapidKeys.publicKey;
      this.vapidPrivateKey = vapidKeys.privateKey;
      fs.writeFileSync(
        VAPID_KEYS_FILE,
        JSON.stringify(
          { publicKey: this.vapidPublicKey, privateKey: this.vapidPrivateKey },
          null,
          2,
        ),
      );
      console.log("[push] Generated new VAPID keys");
    }

    webpush.setVapidDetails(
      process.env.PI_WEB_VAPID_SUBJECT || "mailto:pi-web@example.invalid",
      this.vapidPublicKey,
      this.vapidPrivateKey,
    );

    this.loadSubscriptions();
    this.initialized = true;
    console.log(
      `[push] PushManager initialized (${this.subscriptions.size} subscriptions)`,
    );
  }

  // --- Subscription persistence ---

  private loadSubscriptions(): void {
    if (!fs.existsSync(SUBSCRIPTIONS_FILE)) return;
    try {
      const data = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, "utf-8"));
      if (Array.isArray(data)) {
        this.subscriptions.clear();
        for (const sub of data) {
          this.subscriptions.set(sub.endpoint, sub);
        }
      }
    } catch (err) {
      console.error("[push] Failed to load subscriptions:", err);
    }
  }

  private saveSubscriptions(): void {
    try {
      const data = Array.from(this.subscriptions.values());
      fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[push] Failed to save subscriptions:", err);
    }
  }

  // --- Public API ---

  addSubscription(subscription: PushSubscriptionData): void {
    this.subscriptions.set(subscription.endpoint, subscription);
    this.saveSubscriptions();
  }

  removeSubscription(endpoint: string): boolean {
    const removed = this.subscriptions.delete(endpoint);
    if (removed) this.saveSubscriptions();
    return removed;
  }

  getVapidPublicKey(): string {
    return this.vapidPublicKey;
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  async sendToAll(payload: Record<string, unknown>): Promise<void> {
    // Wait for init to complete if it hasn't already
    if (!this.initialized) {
      console.warn("[push] sendToAll called but PushManager not initialized yet");
      return;
    }

    if (this.subscriptions.size === 0) {
      console.warn("[push] sendToAll called but no subscriptions exist");
      return;
    }

    const count = this.subscriptions.size;
    console.log(`[push] Sending push notification to ${count} subscription(s):`, {
      title: payload.title,
      body: payload.body?.toString().slice(0, 80),
    });

    const payloadString = JSON.stringify(payload);
    const expired: string[] = [];
    let sent = 0;

    for (const [endpoint, subscription] of this.subscriptions) {
      try {
        await webpush.sendNotification(
          subscription as webpush.PushSubscription,
          payloadString,
        );
        sent++;
      } catch (err: unknown) {
        const webErr = err as any;
        const statusCode = webErr?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          expired.push(endpoint);
          console.log(`[push] Subscription expired (${statusCode}), will remove: ${endpoint.slice(0, 50)}...`);
        } else if (statusCode) {
          // Push server returned an error (e.g. 400, 413, 403)
          console.error(
            `[push] Push service returned ${statusCode} for ${endpoint.slice(0, 50)}...:`,
            webErr?.message || webErr,
            `Body: ${(webErr?.body || "").toString().slice(0, 200)}`,
            `Headers: ${JSON.stringify(webErr?.headers || {})}`,
          );
        } else {
          console.error(
            `[push] Send error for ${endpoint.slice(0, 60)}:`,
            webErr?.message || webErr,
          );
        }
      }
    }

    for (const ep of expired) {
      this.subscriptions.delete(ep);
    }
    if (expired.length > 0) {
      this.saveSubscriptions();
      console.log(`[push] Cleaned up ${expired.length} expired subscription(s)`);
    }

    console.log(`[push] Delivered to ${sent}/${count} subscription(s)`);
  }

  async stop(): Promise<void> {
    this.saveSubscriptions();
  }
}
