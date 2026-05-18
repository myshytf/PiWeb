/**
 * Hono HTTP server for pi-web standalone app.
 *
 * Uses PiWebApp instance directly instead of a stale ExtensionContext getter.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiWebApp } from "./app.js";
import { registerApiRoutes } from "./routes/index.js";
import { authMiddleware, registerAuthRoutes } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(__dirname, "..", "frontend", "out");

export function createServer(app: PiWebApp): Hono {
  const hono = new Hono();

  // Security headers for both API and static frontend responses.
  hono.use("*", async (c, next) => {
    await next();
    const isHttps = c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        // Next static export contains inline bootstrap scripts. Keep inline scripts
        // allowed, but block third-party script origins.
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
      ].join("; "),
    );
    if (isHttps) {
      c.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
  });

  // Same-origin CORS only. Cross-site pages should not be able to drive the API.
  const allowedOrigins = (process.env.PI_WEB_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  hono.use(
    "/api/*",
    cors({
      origin: (origin, c) => {
        if (!origin) return undefined;
        if (allowedOrigins.includes(origin)) return origin;
        try {
          const requestHost = c.req.header("host");
          const originHost = new URL(origin).host;
          return requestHost && originHost === requestHost ? origin : undefined;
        } catch {
          return undefined;
        }
      },
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );

  // Basic request-size guard. Attachments are capped at 25MB raw payload; base64 + JSON
  // overhead fits comfortably under this limit.
  hono.use("/api/*", async (c, next) => {
    const length = Number(c.req.header("content-length") || 0);
    if (length > 40 * 1024 * 1024) {
      return c.json({ error: "Request body too large" }, 413);
    }
    await next();
  });

  // Inject PiWebApp instance for route handlers
  hono.use("/api/*", async (c, next) => {
    (c as any)._app = app;
    await next();
  });

  // Auth routes (unprotected)
  registerAuthRoutes(hono);

  // Auth middleware for all /api/* routes
  hono.use("/api/*", authMiddleware());

  // Health check
  hono.get("/api/health", (c) => {
    return c.json({ status: "ok", clients: app.wsManager.getClientCount(), timestamp: Date.now() });
  });

  // API routes
  registerApiRoutes(hono, app);

  // SSE stream as WS fallback
  hono.get("/api/events/stream", async (c) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Send initial snapshot
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "snapshot",
              data: {
                sessionFile: app.session.sessionFile ?? null,
                isStreaming: app.session.isStreaming,
              },
            })}\n\n`,
          ),
        );

        const sseClient: import("./ws-manager.js").WsClient = {
          send: (data: string) => {
            try {
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } catch {
              /* closed */
            }
          },
          close: () => {
            try {
              controller.close();
            } catch {
              /* closed */
            }
          },
        };

        const removeClient = app.wsManager.addClient(sseClient);
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          } catch {
            removeClient();
            clearInterval(heartbeat);
          }
        }, 15000);

        c.req.raw.signal.addEventListener("abort", () => {
          removeClient();
          clearInterval(heartbeat);
        });
      },
    });

    return new Response(stream);
  });

  // Static frontend files
  hono.use("/*", serveStatic({ root: FRONTEND_DIR }));
  hono.get("*", serveStatic({ root: FRONTEND_DIR, path: "index.html" }));

  return hono;
}