import { test, expect } from "@playwright/test";

const USERNAME = process.env.PI_WEB_USERNAME || "piweb";
const PASSWORD = process.env.PI_WEB_PASSWORD || "test-password";

test.describe("Authenticated frontend flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test("does not call protected APIs before login", async ({ page }) => {
    const protectedRequests: string[] = [];

    page.on("request", (request) => {
      const url = new URL(request.url());
      const protectedBeforeLogin =
        url.pathname.startsWith("/api/sessions") ||
        url.pathname.startsWith("/api/files") ||
        url.pathname.startsWith("/api/messages") ||
        url.pathname.startsWith("/api/settings") ||
        url.pathname.startsWith("/api/agent") ||
        url.pathname.startsWith("/api/tools") ||
        url.pathname.startsWith("/api/ui") ||
        url.pathname.startsWith("/api/push");

      if (protectedBeforeLogin) {
        protectedRequests.push(`${url.pathname}${url.search}`);
      }
    });

    await page.reload();
    await expect(page.getByRole("heading", { name: "pi Remote" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
    await page.waitForTimeout(1000);

    expect(protectedRequests).toEqual([]);
  });

  test("opens authenticated WebSocket immediately after login", async ({ page }) => {
    let websocketUrl = "";
    const connectedFrame = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for authenticated WebSocket connected frame")), 5000);

      page.on("websocket", (ws) => {
        websocketUrl = ws.url();
        ws.on("framereceived", (event) => {
          const payload = event.payload.toString();
          if (payload.includes('"type":"connected"')) {
            clearTimeout(timer);
            resolve(payload);
          }
        });
      });
    });

    await page.reload();
    await page.getByRole("textbox", { name: "Username" }).fill(USERNAME);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();

    const frame = await connectedFrame;
    expect(websocketUrl).toContain("/ws");
    expect(websocketUrl).not.toContain("auth=");
    expect(frame).toContain('"type":"connected"');
  });

  test("does not treat stale stored credentials as authenticated", async ({ page }) => {
    const healthRequests: string[] = [];
    const authLoginRequests: string[] = [];
    const protectedRequests: string[] = [];

    await page.evaluate(() => {
      localStorage.setItem(
        "pi_web_auth_credentials",
        JSON.stringify({ username: "piweb", password: "wrong-password" }),
      );
    });

    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/health") healthRequests.push(url.pathname);
      if (url.pathname === "/api/auth/login") authLoginRequests.push(url.pathname);
    });

    page.on("request", (request) => {
      const url = new URL(request.url());
      const protectedPath =
        url.pathname.startsWith("/api/sessions") ||
        url.pathname.startsWith("/api/files") ||
        url.pathname.startsWith("/api/messages") ||
        url.pathname.startsWith("/api/settings") ||
        url.pathname.startsWith("/api/agent") ||
        url.pathname.startsWith("/api/tools") ||
        url.pathname.startsWith("/api/ui") ||
        url.pathname.startsWith("/api/push");
      if (protectedPath) {
        protectedRequests.push(`${url.pathname}${url.search}`);
      }
    });

    await page.reload();
    await expect(page.getByRole("heading", { name: "pi Remote" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
    await page.waitForTimeout(1000);

    expect(authLoginRequests).toContain("/api/auth/login");
    expect(healthRequests).toEqual([]);
    expect(protectedRequests).toEqual([]);
  });

  test("uses the auth cookie when setting up push after login", async ({ page }) => {
    await page.addInitScript(() => {
      const subscription = {
        toJSON: () => ({
          endpoint: "https://example.com/push/auth-flow-test",
          expirationTime: null,
          keys: {
            p256dh: "test-p256dh",
            auth: "test-auth",
          },
        }),
      };
      const registration = {
        active: { state: "activated" },
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async () => subscription,
        },
        addEventListener: () => {},
      };

      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => "granted",
      });
      Object.defineProperty(window, "PushManager", {
        configurable: true,
        value: function PushManager() {},
      });
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => registration,
          ready: Promise.resolve(registration),
          getRegistrations: async () => [],
        },
      });
    });

    let vapidAuthorization: string | undefined;
    let subscribeAuthorization: string | undefined;
    let vapidCookie: string | undefined;
    let subscribeCookie: string | undefined;

    await page.route("**/api/push/vapid-public-key", async (route) => {
      vapidAuthorization = route.request().headers().authorization;
      vapidCookie = route.request().headers().cookie;
      await route.fulfill({ json: { publicKey: "test-public-key" } });
    });
    await page.route("**/api/push/subscribe", async (route) => {
      subscribeAuthorization = route.request().headers().authorization;
      subscribeCookie = route.request().headers().cookie;
      await route.fulfill({ json: { ok: true } });
    });

    await page.reload();
    await page.getByRole("textbox", { name: "Username" }).fill(USERNAME);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect.poll(() => subscribeCookie).toContain("pi_web_auth=");
    expect(vapidCookie).toContain("pi_web_auth=");
    expect(subscribeAuthorization).toBeUndefined();
    expect(vapidAuthorization).toBeUndefined();
  });
});
