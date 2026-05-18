/**
 * Web UI request routes for headless extension interactions.
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";
import type { WebUIPendingRequest } from "../web-ui-bridge.js";

export function registerUiRoutes(app: Hono, piWebApp: PiWebApp) {
  const getApp = (c: any): PiWebApp => c._app as PiWebApp;

  async function readJson(c: any): Promise<any | undefined> {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  }

  function isValidResponseForRequest(request: WebUIPendingRequest, body: any): boolean {
    if (body?.cancelled === true) return true;
    if (request.method === "confirm") return typeof body?.confirmed === "boolean";
    if (request.method === "select" || request.method === "input" || request.method === "editor") {
      return typeof body?.value === "string";
    }
    return false;
  }

  app.get("/api/ui/pending", (c) => {
    const piWeb = getApp(c);
    return c.json({ requests: piWeb.uiBridge?.getPendingRequests?.() ?? [] });
  });

  app.post("/api/ui/respond", async (c) => {
    const piWeb = getApp(c);
    const body = await readJson(c);
    if (!body) return c.json({ error: "Invalid JSON" }, 400);
    if (!body?.id) return c.json({ error: "Request id required" }, 400);
    const request = piWeb.uiBridge?.getPendingRequest?.(body.id);
    if (!request) return c.json({ error: "UI request not found" }, 404);
    if (!isValidResponseForRequest(request, body)) {
      return c.json({ error: "Response payload does not match UI request method" }, 400);
    }
    const ok = piWeb.uiBridge?.respond?.(body) ?? false;
    if (!ok) return c.json({ error: "UI request not found" }, 404);
    return c.json({ status: "ok" });
  });

  app.post("/api/ui/cancel", async (c) => {
    const piWeb = getApp(c);
    const body = await readJson(c);
    if (!body) return c.json({ error: "Invalid JSON" }, 400);
    if (!body?.id) return c.json({ error: "Request id required" }, 400);
    const ok = piWeb.uiBridge?.cancel?.(body.id) ?? false;
    if (!ok) return c.json({ error: "UI request not found" }, 404);
    return c.json({ status: "ok" });
  });
}
