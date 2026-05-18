/**
 * Register all API routes on the Hono app
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerMessageRoutes } from "./messages.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerFileRoutes } from "./file-browser.js";
import { registerToolRoutes } from "./tools.js";
import { registerWsRoute } from "./websocket.js";
import { registerUiRoutes } from "./ui.js";
import { registerPushRoutes } from "./push.js";
import { registerCommandRoutes } from "./commands.js";

export function registerApiRoutes(app: Hono, piWebApp: PiWebApp) {
  registerSessionRoutes(app, piWebApp);
  registerMessageRoutes(app, piWebApp);
  registerSettingsRoutes(app, piWebApp);
  registerFileRoutes(app, piWebApp);
  registerToolRoutes(app, piWebApp);
  registerUiRoutes(app, piWebApp);
  registerPushRoutes(app, piWebApp);
  registerCommandRoutes(app, piWebApp);
  registerWsRoute(app, piWebApp);
}
