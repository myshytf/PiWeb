#!/usr/bin/env node
/**
 * pi-web: Standalone web interface for pi agent
 *
 * Usage: pi-web [setup|config] [options]
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import * as path from "node:path";
import { createApp } from "./app.js";
import { configureAuth } from "./auth.js";
import { defaultAgentDir, defaultConfigFile, defaultCredentialsFile, normalizeTunnelProvider, readConfig, writeConfig, type PiWebConfig, type TunnelProvider } from "./config.js";
import { startTunnel } from "./tunnel.js";

const rawArgs = process.argv.slice(2);
const command = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs[0] : undefined;
const args = command ? rawArgs.slice(1) : rawArgs;
const DEFAULT_USERNAME = "piweb";
const DEFAULT_PORT = "9876";
const DEFAULT_HOST = "127.0.0.1";

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

function getOptionalArg(name: string, inputArgs = args): string | undefined {
  const long = `--${name}`;
  const withEquals = `${long}=`;
  const equalArg = inputArgs.find((arg) => arg.startsWith(withEquals));
  if (equalArg) return equalArg.slice(withEquals.length);

  const idx = inputArgs.indexOf(long);
  if (idx !== -1 && idx + 1 < inputArgs.length && !inputArgs[idx + 1].startsWith("--")) return inputArgs[idx + 1];
  return undefined;
}

function getArg(name: string, defaultValue: string, configValue?: string | number): string {
  return getOptionalArg(name) ?? process.env[envName(name)] ?? (configValue === undefined ? undefined : String(configValue)) ?? defaultValue;
}

function hasFlag(name: string, inputArgs = args): boolean {
  return inputArgs.includes(`--${name}`);
}

function configFileFromArgs(): string {
  const explicitAgentDir = getOptionalArg("agent-dir", rawArgs) ?? process.env.PI_WEB_AGENT_DIR;
  return getOptionalArg("config", rawArgs) ?? process.env.PI_WEB_CONFIG_FILE ?? defaultConfigFile(explicitAgentDir);
}

function credentialsFile(agentDir?: string, config?: PiWebConfig): string {
  return getOptionalArg("credentials-file") ?? process.env.PI_WEB_CREDENTIALS_FILE ?? config?.credentialsFile ?? defaultCredentialsFile(agentDir);
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

function resolveCredentials(agentDir?: string, config?: PiWebConfig): ResolvedCredentials {
  const file = credentialsFile(agentDir, config);
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

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function askYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  const label = defaultValue ? "Y/n" : "y/N";
  const answer = (await ask(`${question} [${label}]`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer.startsWith("y");
}

async function askHidden(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) return ask(question);

  return new Promise((resolve, reject) => {
    const stdin = input;
    const wasRaw = stdin.isRaw;
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      output.write("\n");
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Interrupted"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += char;
        output.write("*");
      }
    };

    output.write(`${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function resolveTunnel(config: PiWebConfig): TunnelProvider {
  if (hasFlag("no-tunnel")) return "none";
  const explicit = normalizeTunnelProvider(getOptionalArg("tunnel") ?? process.env.PI_WEB_TUNNEL);
  if (explicit) return explicit;
  if (config.tunnel?.autostart && config.tunnel.provider) return config.tunnel.provider;
  return "none";
}

async function runSetup(configFile: string, existingConfig: PiWebConfig) {
  const nonInteractive = hasFlag("yes") || hasFlag("ci");
  const existingAgentDir = existingConfig.agentDir || defaultAgentDir();
  const existingCredentialsFile = existingConfig.credentialsFile || defaultCredentialsFile(existingAgentDir);
  const existingCredentials = readStoredCredentials(existingCredentialsFile);

  if (!input.isTTY && !nonInteractive) {
    throw new Error("Interactive setup requires a TTY. Re-run with --yes and options for non-interactive setup.");
  }

  const configuredPort = getOptionalArg("port") ?? process.env.PI_WEB_PORT ?? String(existingConfig.port || DEFAULT_PORT);
  const port = parsePort(nonInteractive ? configuredPort : await ask("Port number", configuredPort));

  const configuredCwd = getOptionalArg("cwd") ?? process.env.PI_WEB_CWD ?? existingConfig.cwd ?? process.cwd();
  const cwd = path.resolve(nonInteractive ? configuredCwd : await ask("Project directory for pi sessions", configuredCwd));

  const configuredAgentDir = getOptionalArg("agent-dir") ?? process.env.PI_WEB_AGENT_DIR ?? existingConfig.agentDir ?? defaultAgentDir();
  const agentDir = path.resolve(nonInteractive ? configuredAgentDir : await ask("Pi agent directory", configuredAgentDir));

  const configuredCredentialsFile = getOptionalArg("credentials-file") ?? process.env.PI_WEB_CREDENTIALS_FILE ?? existingConfig.credentialsFile ?? defaultCredentialsFile(agentDir);
  const credentialsPath = path.resolve(nonInteractive ? configuredCredentialsFile : await ask("Credentials file", configuredCredentialsFile));

  const configuredUsername = getOptionalArg("username") ?? process.env.PI_WEB_USERNAME ?? existingCredentials?.username ?? DEFAULT_USERNAME;
  const username = nonInteractive ? configuredUsername : await ask("Login username", configuredUsername);

  let password = getOptionalArg("password") ?? process.env.PI_WEB_PASSWORD ?? "";
  if (!password && !nonInteractive) {
    password = await askHidden("Login password (leave blank to generate a secure password)");
  }
  let generatedPassword = false;
  if (!password) {
    password = randomBytes(18).toString("base64url");
    generatedPassword = true;
  }
  writeStoredCredentials(credentialsPath, username || DEFAULT_USERNAME, password);

  const localOnlyDefault = (existingConfig.host || DEFAULT_HOST) !== "0.0.0.0";
  const localOnly = nonInteractive ? getArg("host", existingConfig.host || DEFAULT_HOST) !== "0.0.0.0" : await askYesNo("Keep the server local-only by default?", localOnlyDefault);
  const host = getOptionalArg("host") ?? process.env.PI_WEB_HOST ?? (localOnly ? "127.0.0.1" : "0.0.0.0");

  let tunnelProvider = normalizeTunnelProvider(getOptionalArg("tunnel") ?? process.env.PI_WEB_TUNNEL);
  let tunnelAutostart = tunnelProvider !== undefined && tunnelProvider !== "none";

  if (!tunnelProvider && !nonInteractive) {
    const enableTunnel = await askYesNo("Enable a public internet tunnel on startup?", existingConfig.tunnel?.autostart ?? false);
    if (enableTunnel) {
      const answer = await ask("Tunnel provider: cloudflared or ngrok", existingConfig.tunnel?.provider === "ngrok" ? "ngrok" : "cloudflared");
      tunnelProvider = normalizeTunnelProvider(answer) || "cloudflared";
      tunnelAutostart = true;
    } else {
      tunnelProvider = "none";
      tunnelAutostart = false;
    }
  }

  if (!tunnelProvider) tunnelProvider = existingConfig.tunnel?.provider || "none";
  if (tunnelProvider === "none") tunnelAutostart = false;

  const nextConfig: PiWebConfig = {
    port,
    host,
    cwd,
    agentDir,
    credentialsFile: credentialsPath,
    tunnel: {
      provider: tunnelProvider,
      autostart: tunnelAutostart,
    },
  };

  writeConfig(configFile, nextConfig);

  console.log(`\n[pi-web] Setup complete.`);
  console.log(`[pi-web] Config: ${configFile}`);
  console.log(`[pi-web] Credentials: ${credentialsPath}`);
  console.log(`[pi-web] Server: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  if (generatedPassword) {
    console.log(`[pi-web] Generated login username: ${username || DEFAULT_USERNAME}`);
    console.log(`[pi-web] Generated login password: ${password}`);
  } else {
    console.log(`[pi-web] Login username: ${username || DEFAULT_USERNAME}`);
  }
  if (tunnelAutostart && tunnelProvider !== "none") {
    console.log(`[pi-web] Tunnel autostart: ${tunnelProvider}`);
    console.log(`[pi-web] Start it with: pi-web`);
  } else {
    console.log(`[pi-web] Tunnel autostart: off`);
    console.log(`[pi-web] Start a one-off tunnel with: pi-web --tunnel cloudflared`);
  }
}

function showConfig(configFile: string, config: PiWebConfig) {
  console.log(JSON.stringify({ configFile, ...config }, null, 2));
}

function showHelp() {
  console.log(`pi-web - Web interface for pi agent

Usage:
  pi-web [options]                 Start the web UI
  pi-web setup [options]           Run the one-shot setup wizard
  pi-web config                    Print the saved config

Options:
  --config PATH        Config file path (default: ~/.pi/agent/pi-web-config.json, env: PI_WEB_CONFIG_FILE)
  --port PORT          HTTP/WS server port (default: ${DEFAULT_PORT}, env: PI_WEB_PORT)
  --host HOST          Server bind host (default: ${DEFAULT_HOST}, env: PI_WEB_HOST)
  --cwd DIR            Working directory (default: process.cwd(), env: PI_WEB_CWD)
  --agent-dir DIR      Pi agent config directory (default: ~/.pi/agent, env: PI_WEB_AGENT_DIR)
  --credentials-file PATH  Credentials file (default: ~/.pi/agent/pi-web-credentials.json)
  --username USER      HTTP auth username (default: piweb, env: PI_WEB_USERNAME)
  --password PASS      HTTP auth password (env: PI_WEB_PASSWORD; otherwise generated and saved)
  --no-auth            Disable authentication (env: PI_WEB_NO_AUTH=1)
  --tunnel PROVIDER    Start a public tunnel: cloudflared, ngrok, or none (env: PI_WEB_TUNNEL)
  --no-tunnel          Disable saved tunnel autostart for this run
  --https              Enable HTTPS using mkcert certs (~/.pi/certs/)
  --yes                Non-interactive defaults for setup
  -v, --version        Show package version
  -h, --help           Show this help message

Recommended setup:
  pi-web setup

One-off public URL with Cloudflare quick tunnel:
  pi-web --tunnel cloudflared --cwd /path/to/project
`);
}

async function main() {
  if (hasFlag("help", rawArgs) || hasFlag("h", rawArgs)) {
    showHelp();
    process.exit(0);
  }

  if (hasFlag("version", rawArgs) || hasFlag("v", rawArgs)) {
    console.log(readPackageVersion());
    process.exit(0);
  }

  const configFile = configFileFromArgs();
  const config = readConfig(configFile);

  if (command === "setup" || hasFlag("setup", rawArgs)) {
    await runSetup(configFile, config);
    process.exit(0);
  }

  if (command === "config" || hasFlag("show-config", rawArgs)) {
    showConfig(configFile, config);
    process.exit(0);
  }

  if (command && !["start"].includes(command)) {
    console.error(`[pi-web] Unknown command: ${command}`);
    console.error("Run `pi-web --help` for usage.");
    process.exit(1);
  }

  const agentDir = getArg("agent-dir", "", config.agentDir);
  const port = parsePort(getArg("port", DEFAULT_PORT, config.port));
  const host = getArg("host", DEFAULT_HOST, config.host);
  const cwd = getArg("cwd", process.cwd(), config.cwd);
  const https = hasFlag("https") || process.env.PI_WEB_HTTPS === "1";
  const noAuth = hasFlag("no-auth") || process.env.PI_WEB_NO_AUTH === "1";
  const tunnelProvider = resolveTunnel(config);

  if (noAuth) {
    configureAuth({ username: DEFAULT_USERNAME, password: "", enabled: false });
    console.warn("[pi-web] ⚠️  Authentication is disabled. Only use --no-auth on trusted networks.");
  } else {
    const credentials = resolveCredentials(agentDir || undefined, config);
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

    if (tunnelProvider !== "none") {
      startTunnel({ provider: tunnelProvider, port: app.port || port, host });
    }
  } catch (err) {
    console.error("[pi-web] Fatal error:", err);
    process.exit(1);
  }
}

main();
