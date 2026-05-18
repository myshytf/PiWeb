import { test, expect } from "@playwright/test";
import { createServer } from "../src/server.js";
import { bindSessionToWebUI } from "../src/app.js";
import { createWebUIBridge } from "../src/web-ui-bridge.js";

test.describe("Web UI bridge", () => {
  function createAppWithBridge() {
    const events: any[] = [];
    const uiBridge = createWebUIBridge((event) => events.push(event));
    const piWebApp = {
      cwd: process.cwd(),
      uiBridge,
      wsManager: {
        getClientCount: () => 0,
        broadcast: (event: any) => events.push(event),
      },
      session: {
        isStreaming: false,
        sessionFile: "/mock/session.jsonl",
        sessionManager: { getEntries: () => [] },
      },
    };
    return { app: createServer(piWebApp as any), uiBridge, events };
  }

  test("select requests are broadcast, listed, and resolved by response route", async () => {
    const { app, uiBridge, events } = createAppWithBridge();

    const selectedPromise = uiBridge.uiContext.select("Pick a target", ["web", "terminal"]);
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "ui_request",
      data: { method: "select", title: "Pick a target", options: ["web", "terminal"] },
    });

    const pendingRes = await app.request("/api/ui/pending");
    expect(pendingRes.ok).toBeTruthy();
    const pending = await pendingRes.json();
    expect(pending.requests).toHaveLength(1);

    const respondRes = await app.request("/api/ui/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.requests[0].id, value: "terminal" }),
    });
    expect(respondRes.ok).toBeTruthy();
    await expect(selectedPromise).resolves.toBe("terminal");

    const emptyRes = await app.request("/api/ui/pending");
    expect((await emptyRes.json()).requests).toHaveLength(0);
  });

  test("confirm requests resolve to boolean responses", async () => {
    const { app, uiBridge } = createAppWithBridge();

    const confirmPromise = uiBridge.uiContext.confirm("Proceed?", "Run the tool?");
    const pendingRes = await app.request("/api/ui/pending");
    const pending = await pendingRes.json();

    const respondRes = await app.request("/api/ui/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.requests[0].id, confirmed: true }),
    });
    expect(respondRes.ok).toBeTruthy();
    await expect(confirmPromise).resolves.toBe(true);
  });

  test("cancel route resolves pending requests with default cancelled value", async () => {
    const { app, uiBridge } = createAppWithBridge();

    const inputPromise = uiBridge.uiContext.input("Name session", "feature name");
    const pendingRes = await app.request("/api/ui/pending");
    const pending = await pendingRes.json();

    const cancelRes = await app.request("/api/ui/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.requests[0].id }),
    });
    expect(cancelRes.ok).toBeTruthy();
    await expect(inputPromise).resolves.toBeUndefined();
  });

  test("timed out requests are removed and broadcast as resolved", async () => {
    const { app, uiBridge, events } = createAppWithBridge();

    const selectedPromise = uiBridge.uiContext.select("Pick quickly", ["A"], { timeout: 20 });
    await expect.poll(() => uiBridge.getPendingRequests().length).toBe(1);
    await expect(selectedPromise).resolves.toBeUndefined();
    await expect.poll(() => uiBridge.getPendingRequests().length).toBe(0);
    expect(events.some((event) => event.type === "ui_request_resolved")).toBe(true);

    const pendingRes = await app.request("/api/ui/pending");
    expect((await pendingRes.json()).requests).toHaveLength(0);
  });

  test("respond route rejects mismatched response payloads", async () => {
    const { app, uiBridge } = createAppWithBridge();

    void uiBridge.uiContext.confirm("Confirm this", "message");
    const pendingRes = await app.request("/api/ui/pending");
    const pending = await pendingRes.json();

    const badRes = await app.request("/api/ui/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pending.requests[0].id, value: "not a boolean" }),
    });

    expect(badRes.status).toBe(400);
  });

  test("respond route returns 400 for invalid JSON", async () => {
    const { app } = createAppWithBridge();

    const res = await app.request("/api/ui/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });

    expect(res.status).toBe(400);
  });

  test("session binding passes the web UI context to SDK extensions", async () => {
    const uiBridge = createWebUIBridge(() => {});
    let boundUiContext: unknown;
    const session = {
      bindExtensions: async (bindings: any) => {
        boundUiContext = bindings.uiContext;
      },
    };

    await bindSessionToWebUI(session as any, uiBridge);

    expect(boundUiContext).toBe(uiBridge.uiContext);
  });
});
