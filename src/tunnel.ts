import { spawn } from "node:child_process";
import type { TunnelProvider } from "./config.js";

export interface TunnelOptions {
  provider: Exclude<TunnelProvider, "none">;
  port: number;
  host?: string;
}

export interface StartedTunnel {
  provider: Exclude<TunnelProvider, "none">;
  targetUrl: string;
  stop: () => void;
}

function installHint(provider: TunnelOptions["provider"]): string {
  if (provider === "cloudflared") {
    return [
      "Install cloudflared first:",
      "  macOS: brew install cloudflare/cloudflare/cloudflared",
      "  Other: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
    ].join("\n");
  }

  return [
    "Install and authenticate ngrok first:",
    "  macOS: brew install ngrok/ngrok/ngrok",
    "  then:  ngrok config add-authtoken <your-token>",
    "  Docs:  https://ngrok.com/docs/getting-started/",
  ].join("\n");
}

function commandFor(provider: TunnelOptions["provider"], targetUrl: string): { command: string; args: string[] } {
  if (provider === "cloudflared") {
    return { command: "cloudflared", args: ["tunnel", "--url", targetUrl] };
  }
  return { command: "ngrok", args: ["http", targetUrl] };
}

function publicUrlFrom(text: string): string | null {
  const match = text.match(/https:\/\/[^\s"'<>]+/);
  if (!match) return null;
  const url = match[0].replace(/[),.;]+$/, "");
  if (url.includes("trycloudflare.com") || url.includes("ngrok")) return url;
  return null;
}

export function startTunnel(opts: TunnelOptions): StartedTunnel {
  const targetHost = opts.host && opts.host !== "0.0.0.0" ? opts.host : "127.0.0.1";
  const targetUrl = `http://${targetHost}:${opts.port}`;
  const { command, args } = commandFor(opts.provider, targetUrl);
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let printedPublicUrl = false;

  function handleOutput(buffer: Buffer, stream: "stdout" | "stderr") {
    const text = buffer.toString();
    const publicUrl = publicUrlFrom(text);
    if (publicUrl && !printedPublicUrl) {
      printedPublicUrl = true;
      console.log(`[pi-web] 🌐 Public URL (${opts.provider}): ${publicUrl}`);
      console.log("[pi-web] Keep this terminal running while you use the tunnel.");
      return;
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const prefix = stream === "stderr" ? "[pi-web:tunnel]" : "[pi-web:tunnel]";
      console.log(`${prefix} ${trimmed}`);
    }
  }

  child.stdout.on("data", (chunk) => handleOutput(chunk, "stdout"));
  child.stderr.on("data", (chunk) => handleOutput(chunk, "stderr"));
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error(`[pi-web] Failed to start ${opts.provider}: command not found.`);
      console.error(`[pi-web] ${installHint(opts.provider)}`);
      return;
    }
    console.error(`[pi-web] Failed to start ${opts.provider}:`, err.message);
  });
  child.on("exit", (code, signal) => {
    if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") return;
    console.warn(`[pi-web] Tunnel process exited (provider: ${opts.provider}, code: ${code ?? "n/a"}, signal: ${signal ?? "n/a"}).`);
  });

  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(`[pi-web] Starting ${opts.provider} tunnel to ${targetUrl}...`);
  return { provider: opts.provider, targetUrl, stop };
}
