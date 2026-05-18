import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.PI_WEB_REMOTE_URL || "http://localhost:9876";

// Detect if we're running in test mode (without pi)
const TEST_MODE = process.env.PI_WEB_REMOTE_TEST === "1";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  // pi-web talks to one stateful agent session on port 9876. Running tests in
  // multiple workers races session switches, prompts, and CWD changes.
  workers: 1,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10000,
  },
  webServer: TEST_MODE
    ? {
        command: "npx tsx src/test-server.ts",
        port: 9876,
        reuseExistingServer: !process.env.CI,
        timeout: 15000,
      }
    : {
        // In production mode, pi must be running with the extension
        command: "echo 'Waiting for pi-web-remote server (pi must be running)...'",
        reuseExistingServer: true,
        timeout: 5000,
      },
});
