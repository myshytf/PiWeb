import { test, expect } from "@playwright/test";
import { createServer } from "../src/server.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe("Message routes", () => {
  test("POST /api/messages/prompt returns before agent work completes", async () => {
    let promptStarted = false;
    let promptFinished = false;

    const piWebApp = {
      cwd: process.cwd(),
      wsManager: {
        getClientCount: () => 0,
        broadcast: () => {},
      },
      session: {
        isStreaming: false,
        sessionFile: "/mock/session.jsonl",
        sessionManager: { getEntries: () => [] },
        prompt: async () => {
          promptStarted = true;
          await delay(750);
          promptFinished = true;
        },
        followUp: async () => {},
      },
    };

    const app = createServer(piWebApp as any);
    const startedAt = Date.now();
    const res = await app.request("/api/messages/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "long-running prompt" }),
    });
    const elapsed = Date.now() - startedAt;

    expect(res.ok).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: "sent" });
    expect(promptStarted).toBe(true);
    expect(promptFinished).toBe(false);
    expect(elapsed).toBeLessThan(250);

    await delay(900);
    expect(promptFinished).toBe(true);
  });
});
