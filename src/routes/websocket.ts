/**
 * Event snapshot endpoint
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";

export function registerWsRoute(app: Hono, piWebApp: PiWebApp) {
  const getApp = (c: any): PiWebApp => c._app as PiWebApp;

  // HTTP endpoint to get current state snapshot (for initial page load)
  app.get("/api/events/snapshot", async (c) => {
    try {
      const piWeb = getApp(c);

      return c.json({
        sessionFile: piWeb.session.sessionFile ?? null,
        cwd: piWeb.cwd,
        isStreaming: piWeb.isSessionBusy(piWeb.session),
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}