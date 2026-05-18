import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export type TunnelProvider = "none" | "cloudflared" | "ngrok";

export interface PiWebConfig {
  port?: number;
  host?: string;
  cwd?: string;
  agentDir?: string;
  credentialsFile?: string;
  tunnel?: {
    provider?: TunnelProvider;
    autostart?: boolean;
  };
  updatedAt?: string;
}

export function defaultAgentDir(): string {
  return path.join(homedir() || process.env.HOME || "/tmp", ".pi", "agent");
}

export function defaultConfigFile(agentDir?: string): string {
  return process.env.PI_WEB_CONFIG_FILE || path.join(agentDir || defaultAgentDir(), "pi-web-config.json");
}

export function defaultCredentialsFile(agentDir?: string): string {
  return process.env.PI_WEB_CREDENTIALS_FILE || path.join(agentDir || defaultAgentDir(), "pi-web-credentials.json");
}

export function readConfig(file: string): PiWebConfig {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PiWebConfig;
  } catch (err) {
    console.warn(`[pi-web] Failed to read config file ${file}:`, err);
    return {};
  }
}

export function writeConfig(file: string, config: PiWebConfig): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

export function normalizeTunnelProvider(value: string | undefined): TunnelProvider | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "off" || normalized === "false" || normalized === "no") return "none";
  if (normalized === "cloudflare" || normalized === "cloudflared" || normalized === "cf") return "cloudflared";
  if (normalized === "ngrok") return "ngrok";
  return undefined;
}
