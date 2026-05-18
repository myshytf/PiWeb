/**
 * Tool information and agent state routes
 * GET /api/tools       - List available tools
 * GET /api/agent/state - Get agent state
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";
import { serializeTokenUsage } from "../token-usage.js";

export function registerToolRoutes(app: Hono, piWebApp: PiWebApp) {
  const getApp = (c: any): PiWebApp => c._app as PiWebApp;

  // List available tools
  app.get("/api/tools", async (c) => {
    try {
      const piWeb = getApp(c);
      const allTools = piWeb.session.getAllTools();
      const activeNames = new Set(piWeb.session.getActiveToolNames());

      return c.json({
        tools: allTools.map((t: any) => ({
          name: t.name,
          description: t.description ?? null,
          source: t.sourceInfo?.source ?? null,
          active: activeNames.has(t.name),
        })),
        activeCount: activeNames.size,
        totalCount: allTools.length,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Get agent state
  app.get("/api/agent/state", async (c) => {
    try {
      const piWeb = getApp(c);
      const session = piWeb.session;

      return c.json({
        isStreaming: piWeb.isSessionBusy(session),
        sessionFile: session.sessionFile ?? null,
        cwd: piWeb.cwd,
        model: session.model
          ? {
              id: session.model.id,
              provider: session.model.provider,
              name: session.model.name,
              contextWindow: (session.model as any).contextWindow,
              maxTokens: (session.model as any).maxTokens,
              reasoning: (session.model as any).reasoning,
            }
          : null,
        thinkingLevel: session.thinkingLevel,
        tokenUsage: serializeTokenUsage(session),
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}