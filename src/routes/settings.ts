/**
 * Settings routes
 * GET    /api/settings        - Get current settings
 * GET    /api/settings/models  - Get available models
 * POST   /api/settings/model   - Change model
 * POST   /api/settings/thinking - Change thinking level
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";

export function registerSettingsRoutes(app: Hono, piWebApp: PiWebApp) {
  const getApp = (c: any): PiWebApp => c._app as PiWebApp;

  // Get current settings
  app.get("/api/settings", async (c) => {
    try {
      const piWeb = getApp(c);
      const session = piWeb.session;
      const model = session.model;
      const thinkingLevel = session.thinkingLevel;
      const activeTools = session.getActiveToolNames();

      return c.json({
        model: model
          ? {
              id: model.id,
              provider: model.provider,
              name: model.name,
              contextWindow: (model as any).contextWindow,
              maxTokens: (model as any).maxTokens,
              reasoning: (model as any).reasoning,
            }
          : null,
        thinkingLevel,
        activeTools,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Get available models
  app.get("/api/settings/models", async (c) => {
    try {
      const piWeb = getApp(c);
      const modelRegistry = piWeb.session.modelRegistry;
      const models = await modelRegistry.getAvailable();
      const current = piWeb.session.model;

      return c.json({
        models: models.map((m: any) => ({
          id: m.id,
          provider: m.provider,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning,
        })),
        current: current
          ? {
              id: current.id,
              provider: current.provider,
              name: current.name,
              contextWindow: (current as any).contextWindow,
              maxTokens: (current as any).maxTokens,
              reasoning: (current as any).reasoning,
            }
          : null,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Change model
  app.post("/api/settings/model", async (c) => {
    try {
      const piWeb = getApp(c);
      const { provider, id } = await c.req.json();
      if (!provider || !id) return c.json({ error: "provider and id required" }, 400);

      const model = piWeb.session.modelRegistry.find(provider, id);
      if (!model) return c.json({ error: "Model not found" }, 404);

      await piWeb.session.setModel(model);
      await piWeb.session.settingsManager.flush?.();

      return c.json({
        status: "ok",
        model: {
          id: piWeb.session.model?.id ?? model.id,
          provider: piWeb.session.model?.provider ?? model.provider,
          name: piWeb.session.model?.name ?? model.name,
          contextWindow: (piWeb.session.model as any)?.contextWindow,
          maxTokens: (piWeb.session.model as any)?.maxTokens,
          reasoning: (piWeb.session.model as any)?.reasoning,
        },
        thinkingLevel: piWeb.session.thinkingLevel,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Change thinking level
  app.post("/api/settings/thinking", async (c) => {
    try {
      const piWeb = getApp(c);
      const { level } = await c.req.json();
      if (!level) return c.json({ error: "level required" }, 400);

      const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
      if (!validLevels.includes(level))
        return c.json({ error: `Invalid thinking level. Must be one of: ${validLevels.join(", ")}` }, 400);

      piWeb.session.setThinkingLevel(level);
      await piWeb.session.settingsManager.flush?.();

      return c.json({ status: "ok", level: piWeb.session.thinkingLevel });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}