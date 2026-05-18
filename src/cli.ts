#!/usr/bin/env node
/**
 * pi-web: Standalone web interface for pi agent
 *
 * Usage: pi-web [--port PORT] [--host HOST] [--cwd DIR]
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { createApp } from "./app.js";
import { configureAuth } from "./auth.js";

const args = process.argv.slice(2);
const DEFAULT_USERNAME = "piweb";

type CredentialSource = "explicit" | "file" | "generated";

interface ResolvedCredentials {
  username: string;
  password: string;
  file: string;
  source: CredentialSource;
}

function envName(name: string): string {
  return `PI_WEB_${name.toUpperCase().replace(/-/g, "_")}`;
}

function getOptionalArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function getArg(name: string, defaultValue: string): string {
  return getOptionalArg(name) ?? process.env[envName(name)] ?? defaultValue;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function defaultAgentDir(): string {
  return path.join(homedir() || process.env.HOME || "/tmp", ".pi", "agent");
}

function credentialsFile(agentDir?: string): string {
  return process.env.PI_WEB_CREDENTIALS_FILE || path.join(agentDir || defaultAgentDir(), "pi-web-credentials.json");
}

function readStoredCredentials(file: string): { username?: string; password?: string } | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[pi-web] Failed to read credentials file ${file}:`, err);
    return null;
  }
}

function writeStoredCredentials(file: string, username: string, password: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        username,
        password,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

function resolveCredentials(agentDir?: string): ResolvedCredentials {
  const file = credentialsFile(agentDir);
  const explicitUsername = getOptionalArg("username") ?? process.env.PI_WEB_USERNAME;
  const explicitPassword = getOptionalArg("password") ?? process.env.PI_WEB_PASSWORD;
  const stored = readStoredCredentials(file);

  if (explicitPassword) {
    return {
      username: explicitUsername || stored?.username || DEFAULT_USERNAME,
      password: explicitPassword,
      file,
      source: "explicit",
    };
  }

  if (stored?.password) {
    return {
      username: explicitUsername || stored.username || DEFAULT_USERNAME,
      password: stored.password,
      file,
      source: "file",
    };
  }

  const username = explicitUsername || DEFAULT_USERNAME;
  const password = randomBytes(18).toString("base64url");
  writeStoredCredentials(file, username, password);
  return { username, password, file, source: "generated" };
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    console.log(`pi-web - Web interface for pi agent

Usage: pi-web [options]

Options:
  --port PORT         HTTP/WS server port (default: 9876, env: PI_WEB_PORT)
  --host HOST         Server bind host (default: 0.0.0.0, env: PI_WEB_HOST)
  --cwd DIR           Working directory (default: process.cwd(), env: PI_WEB_CWD)
  --agent-dir DIR     Pi agent config directory (default: ~/.pi/agent, env: PI_WEB_AGENT_DIR)
  --username USER     HTTP auth username (default: piweb, env: PI_WEB_USERNAME)
  --password PASS     HTTP auth password (env: PI_WEB_PASSWORD; otherwise generated and saved)
  --no-auth           Disable authentication (env: PI_WEB_NO_AUTH=1)
  --https             Enable HTTPS using mkcert certs (~/.pi/certs/)
  -v, --version       Show package version
  -h, --help          Show this help message

Credential file:
  ${credentialsFile(getOptionalArg("agent-dir") ?? process.env.PI_WEB_AGENT_DIR)}
  Override with PI_WEB_CREDENTIALS_FILE=/path/to/credentials.json
`);
    process.exit(0);
  }

  if (hasFlag("version") || hasFlag("v")) {
    console.log(readPackageVersion());
    process.exit(0);
  }

  const port = parseInt(getArg("port", "9876"), 10);
  const host = getArg("host", "0.0.0.0");
  const cwd = getArg("cwd", process.cwd());
  const agentDir = getArg("agent-dir", "");

  const https = hasFlag("https");
  const noAuth = hasFlag("no-auth") || process.env.PI_WEB_NO_AUTH === "1";

  if (noAuth) {
    configureAuth({ username: DEFAULT_USERNAME, password: "", enabled: false });
    console.warn("[pi-web] ⚠️  Authentication is disabled. Only use --no-auth on trusted networks.");
  } else {
    const credentials = resolveCredentials(agentDir || undefined);
    configureAuth({
      username: credentials.username,
      password: credentials.password,
      enabled: true,
    });

    if (credentials.source === "generated") {
      console.log(`[pi-web] Created login credentials at ${credentials.file}`);
      console.log(`[pi-web] Username: ${credentials.username}`);
      console.log(`[pi-web] Password: ${credentials.password}`);
    } else if (credentials.source === "file") {
      console.log(`[pi-web] Using login credentials from ${credentials.file} (username: ${credentials.username})`);
    } else {
      console.log(`[pi-web] Authentication enabled (username: ${credentials.username})`);
    }
  }

  try {
    const app = await createApp({
      port,
      host,
      cwd,
      agentDir: agentDir || undefined,
      https,
    });

    await app.start();
  } catch (err) {
    console.error("[pi-web] Fatal error:", err);
    process.exit(1);
  }
}

main();
