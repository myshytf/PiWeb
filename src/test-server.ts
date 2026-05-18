/**
 * Test server for E2E tests - starts the Hono server with a mock PiWebApp
 *
 * This allows running E2E tests without a live pi agent.
 * The mock PiWebApp provides basic session/file operations using real filesystem.
 *
 * Usage: npx tsx src/test-server.ts
 * Then run: npx playwright test
 */

import { createServer } from "./server.js";
import { createWsManager, type WsClient } from "./ws-manager.js";
import { PiWebApp } from "./app.js";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";
import { createServer as createHttpServer } from "node:http";
import { configureAuth } from "./auth.js";

const TEST_PORT = Number(process.env.PI_WEB_PORT || process.env.PI_WEB_REMOTE_PORT) || 9876;
const TEST_HOST = process.env.PI_WEB_HOST || process.env.PI_WEB_REMOTE_HOST || "127.0.0.1";
const TEST_USERNAME = process.env.PI_WEB_USERNAME || "piweb";
const TEST_PASSWORD = process.env.PI_WEB_PASSWORD || "test-password";

configureAuth({
  username: TEST_USERNAME,
  password: TEST_PASSWORD,
  enabled: process.env.PI_WEB_NO_AUTH !== "1",
});

// Minimal mock of AgentSession for testing
function createMockSession(): AgentSession {
  const mockSm = {
    getSessionFile: () => "/mock/session/test-session.jsonl",
    getSessionId: () => "test-session-id",
    getEntries: () => [],
    getTree: () => [],
    getBranch: () => [],
    getLeafEntry: () => null,
    getLeafId: () => null,
    getCwd: () => process.cwd(),
    list: async () => [],
    listAll: async () => [],
  };

  const mockModelRegistry = {
    getAvailable: async () => [
      { id: "test-model", provider: "test", name: "Test Model", contextWindow: 128000, maxTokens: 4096, reasoning: false },
    ],
    find: (provider: string, id: string) => {
      const models = [
        { id: "test-model", provider: "test", name: "Test Model", contextWindow: 128000, maxTokens: 4096, reasoning: false },
      ];
      return models.find((m) => m.provider === provider && m.id === id);
    },
  };

  return {
    sessionManager: mockSm as any,
    modelRegistry: mockModelRegistry as any,
    model: { id: "test-model", provider: "test", name: "Test Model", contextWindow: 128000, maxTokens: 4096, reasoning: false } as any,
    isStreaming: false,
    sessionFile: "/mock/session/test-session.jsonl",
    sessionId: "test-session-id",
    thinkingLevel: "medium" as any,
    subscribe: () => () => {},
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    getActiveToolNames: () => ["bash", "read", "write", "edit"],
    getAllTools: () => [
      { name: "bash", description: "Execute bash commands", sourceInfo: { source: "builtin" } },
      { name: "read", description: "Read file contents", sourceInfo: { source: "builtin" } },
      { name: "write", description: "Write file contents", sourceInfo: { source: "builtin" } },
      { name: "edit", description: "Edit file contents", sourceInfo: { source: "builtin" } },
    ],
    sendUserMessage: async () => {},
    dispose: () => {},
  } as any as AgentSession;
}

// Minimal mock runtime for testing
function createMockRuntime() {
  const session = createMockSession();
  return {
    session,
    cwd: process.cwd(),
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false, selectedText: undefined }),
    dispose: async () => {},
    setRebindSession: () => {},
    diagnostics: [],
    modelFallbackMessage: undefined,
  };
}

function createMockPiWebApp(): PiWebApp {
  const wsManager = createWsManager();
  const session = createMockSession();
  const mockRuntime = createMockRuntime();

  const app = new PiWebApp({ port: TEST_PORT, host: TEST_HOST, cwd: process.cwd() });

  // Override properties with mocks (skip start())
  (app as any).session = session;
  (app as any).runtime = mockRuntime;
  (app as any).wsManager = wsManager;
  (app as any).port = TEST_PORT;
  (app as any).cwd = process.cwd();
  (app as any).agentDir = "";

  return app;
}

async function startTestServer() {
  const piWeb = createMockPiWebApp();

  // Initialize push manager before starting server so VAPID keys are ready
  await piWeb.pushManager.init().catch((err) => {
    console.error("[push-test] Push manager init failed:", err);
  });

  const app = createServer(piWeb);

  const { serve } = await import("@hono/node-server");
  const httpServer = serve({ fetch: app.fetch, port: TEST_PORT, hostname: TEST_HOST });

  // The `serve()` from @hono/node-server returns the underlying http.Server.
  // WebSocket server attaches to the same http.Server.
  const wss = new WebSocketServer({ server: httpServer as any, path: "/ws" });

  wss.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        type: "connected",
        data: { sessionFile: "/mock/session/test-session.jsonl", isStreaming: false },
      }),
    );

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong", id: msg.id }));
      } catch {
        /* ignore */
      }
    });

    ws.on("close", () => {
      /* cleanup */
    });
    ws.on("error", () => {
      /* cleanup */
    });
  });

  console.log(`[pi-web-test] 🧪 Test server running at http://${TEST_HOST}:${TEST_PORT}`);
  console.log(`[pi-web-test] 📡 WebSocket at ws://${TEST_HOST}:${TEST_PORT}/ws`);
  console.log(`[pi-web-test] Running in test mode with mock context`);
  console.log(`[pi-web-test] Press Ctrl+C to stop`);

  process.on("SIGINT", () => {
    console.log("\n[pi-web-test] Shutting down...");
    wss.close();
    httpServer.close();
    process.exit(0);
  });
}

startTestServer().catch((err) => {
  console.error("[pi-web-test] Failed to start:", err);
  process.exit(1);
});