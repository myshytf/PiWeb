import { test, expect } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";

test.describe("Session routes", () => {
  test("POST /api/sessions/new-with-cwd immediately updates app cwd", async () => {
    const targetCwd = await mkdtemp(join(tmpdir(), "pi-web-cwd-"));
    let createRuntimeCwd: string | null = null;

    const piWebApp: any = {
      cwd: process.cwd(),
      wsManager: {
        getClientCount: () => 0,
        broadcast: () => {},
      },
      runtime: {
        services: { agentDir: "" },
        emitBeforeSwitch: async () => ({ cancelled: false }),
        teardownCurrent: async () => {},
        createRuntime: async (options: { cwd: string }) => {
          createRuntimeCwd = options.cwd;
          return {
          cwd: options.cwd,
          session: {
            isStreaming: false,
            sessionFile: "/mock/new-session.jsonl",
            sessionId: "new-session",
            model: null,
            sessionManager: {
              getTree: () => [],
              getEntries: () => [],
            },
          },
        };
        },
        apply: (replacement: any) => {
          piWebApp.runtime.cwd = replacement.cwd;
          piWebApp.runtime.session = replacement.session;
        },
        finishSessionReplacement: async () => {},
        switchSession: async () => ({ cancelled: false }),
      },
      session: {
        isStreaming: false,
        sessionFile: "/mock/old-session.jsonl",
        sessionId: "old-session",
        model: null,
        sessionManager: {
          getTree: () => [],
          getEntries: () => [],
        },
      },
    };

    const app = createServer(piWebApp as any);
    const res = await app.request("/api/sessions/new-with-cwd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: targetCwd }),
    });

    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.cwd).toBe(targetCwd);
    expect(piWebApp.cwd).toBe(targetCwd);
    expect(createRuntimeCwd).toBe(targetCwd);
  });
});
