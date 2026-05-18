/**
 * File browser routes
 * GET  /api/files/list?path=...  - List directory
 * GET  /api/files/read?path=...  - Read file
 * GET  /api/files/tree?path=...  - Directory tree
 * POST /api/files/write          - Write file
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";
import { resolveReadableWorkspacePath, resolveWritableWorkspacePath } from "../security.js";

export function registerFileRoutes(app: Hono, piWebApp: PiWebApp) {
  // List directory
  app.get("/api/files/list", async (c) => {
    try {
      const piWeb = (c as any)._app as PiWebApp;
      const requestedPath = c.req.query("path") || piWeb.cwd;
      const dirPath = await resolveReadableWorkspacePath(requestedPath, piWeb.cwd);
      const { readdir, stat } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const entries = (await readdir(dirPath, { withFileTypes: true })).slice(0, 500);
      const items = await Promise.all(
        entries
          .filter((e: any) => !e.name.startsWith(".") || e.name === ".pi")
          .map(async (entry: any) => {
            try {
              const fullPath = join(dirPath, entry.name);
              const s = await stat(fullPath);
              return { name: entry.name, path: fullPath, type: entry.isDirectory() ? "directory" : "file", size: s.size, modified: s.mtimeMs };
            } catch { return null; }
          })
      );

      return c.json({ path: dirPath, entries: items.filter(Boolean) });
    } catch (err: any) {
      if (String(err.message || "").includes("outside the allowed workspace roots")) {
        return c.json({ error: "Path is outside the allowed workspace roots" }, 403);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  // Read file content
  app.get("/api/files/read", async (c) => {
    try {
      const requestedPath = c.req.query("path");
      if (!requestedPath) return c.json({ error: "path parameter required" }, 400);
      const piWeb = (c as any)._app as PiWebApp;
      const filePath = await resolveReadableWorkspacePath(requestedPath, piWeb.cwd);

      const { readFile, stat } = await import("node:fs/promises");
      const { extname } = await import("node:path");

      const s = await stat(filePath);
      if (s.size > 1024 * 1024) return c.json({ error: "File too large (>1MB)" }, 400);

      const content = await readFile(filePath, "utf-8");
      return c.json({ path: filePath, content, size: s.size, modified: s.mtimeMs, extension: extname(filePath) });
    } catch (err: any) {
      if (String(err.message || "").includes("outside the allowed workspace roots")) return c.json({ error: "Path is outside the allowed workspace roots" }, 403);
      if (err.code === "ENOENT") return c.json({ error: "File not found" }, 404);
      if (err.code === "EACCES") return c.json({ error: "Permission denied" }, 403);
      return c.json({ error: err.message }, 500);
    }
  });

  // Write file content
  app.post("/api/files/write", async (c) => {
    try {
      const { path: requestedPath, content } = await c.req.json();
      if (!requestedPath || content === undefined) return c.json({ error: "path and content required" }, 400);
      if (typeof content !== "string") return c.json({ error: "content must be a string" }, 400);
      if (content.length > 2 * 1024 * 1024) return c.json({ error: "File too large (>2MB)" }, 400);
      const piWeb = (c as any)._app as PiWebApp;
      const filePath = await resolveWritableWorkspacePath(requestedPath, piWeb.cwd);

      const { writeFile } = await import("node:fs/promises");

      await writeFile(filePath, content, "utf-8");

      return c.json({ status: "ok", path: filePath, size: content.length });
    } catch (err: any) {
      const message = String(err.message || "");
      if (message.includes("outside the allowed workspace roots")) return c.json({ error: "Path is outside the allowed workspace roots" }, 403);
      if (message.includes("symbolic link")) return c.json({ error: "Refusing to write through a symbolic link" }, 403);
      if (err.code === "EACCES") return c.json({ error: "Permission denied" }, 403);
      return c.json({ error: err.message }, 500);
    }
  });

  // Directory tree
  app.get("/api/files/tree", async (c) => {
    try {
      const piWeb = (c as any)._app as PiWebApp;
      const requestedPath = c.req.query("path") || piWeb.cwd;
      const rootPath = await resolveReadableWorkspacePath(requestedPath, piWeb.cwd);
      const depth = Math.max(0, Math.min(4, parseInt(c.req.query("depth") || "2", 10) || 2));
      const tree = await buildTree(rootPath, depth, 0);
      return c.json(tree);
    } catch (err: any) {
      if (String(err.message || "").includes("outside the allowed workspace roots")) {
        return c.json({ error: "Path is outside the allowed workspace roots" }, 403);
      }
      return c.json({ error: err.message }, 500);
    }
  });
}

interface FileNode { name: string; path: string; type: "file" | "directory"; children?: FileNode[] }

async function buildTree(dirPath: string, maxDepth: number, currentDepth: number): Promise<FileNode> {
  const { readdir, stat } = await import("node:fs/promises");
  const { join, basename } = await import("node:path");

  const name = basename(dirPath) || dirPath;
  const node: FileNode = { name, path: dirPath, type: "directory" };

  if (currentDepth >= maxDepth) return node;

  try {
    const entries = (await readdir(dirPath, { withFileTypes: true })).slice(0, 500);
    const children: FileNode[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const child = await buildTree(fullPath, maxDepth, currentDepth + 1);
        children.push(child);
      } else {
        try {
          const s = await stat(fullPath);
          children.push({ name: entry.name, path: fullPath, type: "file" });
        } catch { /* skip */ }
      }
    }

    node.children = children;
  } catch { /* permission denied */ }

  return node;
}