/**
 * Session management routes
 * GET    /api/sessions           - List sessions
 * GET    /api/sessions/current    - Get current session info
 * GET    /api/sessions/tree       - Get session tree structure
 * POST   /api/sessions/new        - Create new session
 * POST   /api/sessions/new-with-cwd - Create new session in a specific directory
 * POST   /api/sessions/switch     - Switch to existing session
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assertDirectory, resolveReadableWorkspacePath } from "../security.js";


const SESSION_LIST_CACHE_TTL_MS = 30000;
let sessionListCache: {
  cwd: string;
  scope: string;
  timestamp: number;
  payload: any;
} | null = null;
let sessionListInFlight: Promise<any> | null = null;
let sessionListInFlightKey: string | null = null;

function invalidateSessionListCache() {
  sessionListCache = null;
  sessionListInFlight = null;
  sessionListInFlightKey = null;
}

function serializeSessionInfo(s: any, statuses?: Record<string, any>) {
  const status = statuses?.[s.path];
  return {
    sessionId: s.id,
    title: s.name ?? null,
    createdAt: s.created ? new Date(s.created).getTime() : null,
    updatedAt: s.modified ? new Date(s.modified).getTime() : null,
    cwd: s.cwd,
    file: s.path,
    firstMessage: s.firstMessage ?? null,
    isStreaming: status?.isStreaming ?? false,
    isActive: status?.isActive ?? false,
    pendingMessageCount: status?.pendingMessageCount ?? 0,
    status: status?.status ?? "waiting",
  };
}

function sortRecentFirst<T extends { updatedAt?: number | null; createdAt?: number | null }>(sessions: T[]): T[] {
  return sessions.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
}

function applyLiveSessionStatuses(payload: any, statuses: Record<string, any>) {
  const apply = (session: any) => {
    const status = statuses[session.file];
    return {
      ...session,
      isStreaming: status?.isStreaming ?? false,
      isActive: status?.isActive ?? false,
      pendingMessageCount: status?.pendingMessageCount ?? 0,
      status: status?.status ?? "waiting",
    };
  };
  return {
    project: (payload.project ?? []).map(apply),
    all: (payload.all ?? []).map(apply),
  };
}

export function registerSessionRoutes(app: Hono, piWebApp: PiWebApp) {
  // Helper to get PiWebApp from context
  const getApp = (c: any): PiWebApp => c._app as PiWebApp;

  // List sessions
  app.get("/api/sessions", async (c) => {
    try {
      const piWeb = getApp(c);
      const cwd = piWeb.cwd;
      const refresh = c.req.query("refresh") === "1";
      const scope = c.req.query("scope") ?? "both";
      const now = Date.now();

      if (!refresh && sessionListCache && sessionListCache.cwd === cwd && sessionListCache.scope === scope && now - sessionListCache.timestamp < SESSION_LIST_CACHE_TTL_MS) {
        return c.json(applyLiveSessionStatuses(sessionListCache.payload, piWeb.getSessionStatuses()));
      }

      const cacheKey = `${cwd}:${scope}`;
      if (!refresh && sessionListInFlight && sessionListInFlightKey === cacheKey) {
        return c.json(applyLiveSessionStatuses(await sessionListInFlight, piWeb.getSessionStatuses()));
      }

      sessionListInFlightKey = cacheKey;
      sessionListInFlight = (async () => {
        const statuses = piWeb.getSessionStatuses();
        if (scope === "project") {
          const projectSessions = await SessionManager.list(cwd);
          const payload = {
            project: sortRecentFirst(projectSessions.map((s: any) => serializeSessionInfo(s, statuses))),
            all: [],
          };
          sessionListCache = { cwd, scope, timestamp: Date.now(), payload };
          sessionListInFlight = null;
          sessionListInFlightKey = null;
          return payload;
        }

        // Use static SessionManager methods for listing. Run both scans in parallel.
        const [projectSessions, allSessions] = await Promise.all([
          SessionManager.list(cwd),
          SessionManager.listAll(),
        ]);

        const payload = {
          project: sortRecentFirst(projectSessions.map((s: any) => serializeSessionInfo(s, statuses))),
          all: sortRecentFirst(allSessions.map((s: any) => serializeSessionInfo(s, statuses))),
        };
        sessionListCache = { cwd, scope, timestamp: Date.now(), payload };
        sessionListInFlight = null;
        sessionListInFlightKey = null;
        return payload;
      })().catch((error) => {
        sessionListInFlight = null;
        sessionListInFlightKey = null;
        throw error;
      });

      return c.json(await sessionListInFlight);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Current session info
  app.get("/api/sessions/current", async (c) => {
    try {
      const piWeb = getApp(c);
      const session = piWeb.session;

      return c.json({
        sessionFile: session.sessionFile ?? null,
        sessionId: session.sessionId,
        isStreaming: piWeb.isSessionBusy(session),
        cwd: piWeb.cwd,
        model: session.model
          ? {
              id: session.model.id,
              provider: session.model.provider,
              name: session.model.name,
            }
          : null,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Get session tree structure
  app.get("/api/sessions/tree", async (c) => {
    try {
      const piWeb = getApp(c);
      const sm = piWeb.session.sessionManager;
      const tree = sm.getTree();
      const entries = sm.getEntries();

      return c.json({
        tree: tree.map(serializeTreeNode),
        entries: entries.map((e: any) => ({
          id: e.id,
          type: e.type,
          parentId: e.parentId,
        })),
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Create new session (in current cwd)
  app.post("/api/sessions/new", async (c) => {
    try {
      const piWeb = getApp(c);

      const result = await piWeb.createNewRuntimeSession();
      invalidateSessionListCache();

      return c.json({
        status: result.cancelled ? "cancelled" : "ok",
        sessionFile: result.sessionFile ?? null,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Create new session in a specific directory — NEW feature
  app.post("/api/sessions/new-with-cwd", async (c) => {
    try {
      const piWeb = getApp(c);
      const body = await c.req.json().catch(() => ({}));
      const cwdInput = body.cwd;

      if (!cwdInput || typeof cwdInput !== "string") {
        return c.json({ error: "cwd parameter required" }, 400);
      }

      let newCwd: string;
      try {
        newCwd = await resolveReadableWorkspacePath(cwdInput, piWeb.cwd);
        await assertDirectory(newCwd);
      } catch (err: any) {
        if (String(err.message || "").includes("outside the allowed workspace roots")) {
          return c.json({ error: "Path is outside the allowed workspace roots" }, 403);
        }
        return c.json({ error: "Directory does not exist or is not accessible" }, 404);
      }

      const newSessionManager = SessionManager.create(newCwd);
      const newSessionFile = newSessionManager.getSessionFile();

      if (!newSessionFile) {
        return c.json({ error: "Failed to create session file" }, 500);
      }

      const result = await piWeb.createNewRuntimeSession({
        cwd: newCwd,
        sessionManager: newSessionManager,
        reason: "new",
      });
      invalidateSessionListCache();

      return c.json({
        status: "ok",
        sessionFile: result.sessionFile,
        sessionId: result.sessionId,
        cwd: result.cwd,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Lightweight message preview for cold session switches.
  // This reads the JSONL session file without creating a full runtime.
  app.get("/api/sessions/messages", async (c) => {
    try {
      const piWeb = getApp(c);
      const sessionFile = c.req.query("sessionFile");
      if (!sessionFile) return c.json({ error: "sessionFile required" }, 400);
      const safeSessionFile = piWeb.resolveSessionFilePath(sessionFile);

      const tailParam = c.req.query("tail");
      const tail = tailParam ? Math.max(1, Math.min(500, parseInt(tailParam, 10) || 120)) : 120;
      const sm = SessionManager.open(safeSessionFile);
      return c.json({
        sessionFile: sm.getSessionFile() ?? safeSessionFile,
        cwd: sm.getCwd(),
        messages: piWeb.getMessagesForSessionFile(safeSessionFile, { tail }),
      });
    } catch (err: any) {
      if (String(err.message || "").includes("sessionFile")) return c.json({ error: err.message }, 403);
      return c.json({ error: err.message }, 500);
    }
  });

  // Prewarm session runtimes so switching is near-instant.
  // Fire-and-forget: this endpoint returns immediately while runtimes warm in background.
  app.post("/api/sessions/prewarm", async (c) => {
    try {
      const piWeb = getApp(c);
      const body = await c.req.json().catch(() => ({}));
      const sessionFiles = Array.isArray(body.sessionFiles)
        ? body.sessionFiles.filter((file: unknown): file is string => typeof file === "string" && file.length > 0)
        : typeof body.sessionFile === "string"
          ? [body.sessionFile]
          : [];

      if (sessionFiles.length === 0) {
        return c.json({ status: "ok", warmed: 0 });
      }

      const limit = body.priority === true ? 8 : 6;
      piWeb.prewarmSessions(sessionFiles.slice(0, limit), { priority: body.priority === true });
      return c.json({ status: "warming", requested: Math.min(sessionFiles.length, limit) });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Switch to existing session
  app.post("/api/sessions/switch", async (c) => {
    try {
      const piWeb = getApp(c);
      const { sessionFile } = await c.req.json();
      if (!sessionFile) return c.json({ error: "sessionFile required" }, 400);

      const result = await piWeb.activateSession(sessionFile);

      return c.json({
        status: result.cancelled ? "cancelled" : "ok",
        sessionFile: result.sessionFile ?? null,
      });
    } catch (err: any) {
      if (String(err.message || "").includes("sessionFile")) return c.json({ error: err.message }, 403);
      return c.json({ error: err.message }, 500);
    }
  });
}

interface TreeNode {
  id: string;
  type: string;
  parentId: string | null;
  role?: string;
  labelCount?: number;
  children: TreeNode[];
  label?: string;
}

function serializeTreeNode(node: any): TreeNode {
  const entry = node.entry ?? node;
  return {
    id: entry.id,
    type: entry.type ?? "unknown",
    parentId: entry.parentId ?? null,
    ...("role" in entry ? { role: entry.role } : {}),
    label: node.label,
    children: (node.children ?? []).map(serializeTreeNode),
  };
}

