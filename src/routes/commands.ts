/**
 * Slash command routes.
 * Mirrors pi interactive slash command discovery where possible and executes
 * supported commands through the same AgentSession APIs used by pi.
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  argumentHint?: string;
}

const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  { name: "settings", description: "Open settings menu", source: "builtin" },
  { name: "model", description: "Select model or switch to provider/model", source: "builtin", argumentHint: "provider/model" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", source: "builtin" },
  { name: "export", description: "Export session (HTML default, or specify .html/.jsonl path)", source: "builtin", argumentHint: "[file]" },
  { name: "import", description: "Import and resume a session from a JSONL file", source: "builtin", argumentHint: "file.jsonl" },
  { name: "share", description: "Share session as a secret GitHub gist", source: "builtin" },
  { name: "copy", description: "Copy last agent message to clipboard", source: "builtin" },
  { name: "name", description: "Set session display name", source: "builtin", argumentHint: "name" },
  { name: "session", description: "Show session info and stats", source: "builtin" },
  { name: "changelog", description: "Show version history", source: "builtin" },
  { name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin" },
  { name: "fork", description: "Create a new fork from a previous user message", source: "builtin" },
  { name: "clone", description: "Duplicate the current session at the current position", source: "builtin" },
  { name: "tree", description: "Navigate session tree (switch branches)", source: "builtin" },
  { name: "login", description: "Configure provider authentication", source: "builtin" },
  { name: "logout", description: "Remove provider authentication", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "compact", description: "Manually compact the session context", source: "builtin", argumentHint: "[instructions]" },
  { name: "resume", description: "Resume a different session", source: "builtin" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes", source: "builtin" },
  { name: "quit", description: "Quit pi", source: "builtin" },
];

function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return { name: trimmed.slice(1), args: "" };
  return { name: trimmed.slice(1, spaceIndex), args: trimmed.slice(spaceIndex + 1).trim() };
}

function sessionCommands(session: AgentSession): SlashCommandInfo[] {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((command) => command.name));

  const extensionCommands = session.extensionRunner
    .getRegisteredCommands()
    .filter((command: any) => !builtinNames.has(command.name))
    .map((command: any) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension" as const,
    }));

  const promptCommands = session.promptTemplates.map((template: any) => ({
    name: template.name,
    description: template.description,
    source: "prompt" as const,
    argumentHint: template.argumentHint,
  }));

  const skills = session.resourceLoader.getSkills().skills.map((skill: any) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill" as const,
  }));

  const seen = new Set<string>();
  return [...BUILTIN_COMMANDS, ...promptCommands, ...extensionCommands, ...skills]
    .filter((command) => {
      if (!command.name || seen.has(command.name)) return false;
      seen.add(command.name);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatSessionStats(session: AgentSession): string {
  const stats = session.getSessionStats();
  const sessionName = session.sessionManager.getSessionName();
  const lines = ["Session Info", ""];
  if (sessionName) lines.push(`Name: ${sessionName}`);
  lines.push(
    `File: ${stats.sessionFile ?? "In-memory"}`,
    `ID: ${stats.sessionId}`,
    "",
    "Messages",
    `User: ${stats.userMessages}`,
    `Assistant: ${stats.assistantMessages}`,
    `Tool Calls: ${stats.toolCalls}`,
    `Tool Results: ${stats.toolResults}`,
    `Total: ${stats.totalMessages}`,
    "",
    "Tokens",
    `Input: ${stats.tokens.input.toLocaleString()}`,
    `Output: ${stats.tokens.output.toLocaleString()}`,
    `Cache Read: ${stats.tokens.cacheRead.toLocaleString()}`,
    `Cache Write: ${stats.tokens.cacheWrite.toLocaleString()}`,
    `Total: ${stats.tokens.total.toLocaleString()}`,
  );
  if (stats.cost > 0) lines.push("", "Cost", `Total: $${stats.cost.toFixed(4)}`);
  return lines.join("\n");
}

async function startSlashPrompt(piWeb: PiWebApp, session: AgentSession, text: string): Promise<{ status: string; message: string }> {
  const inFlight = piWeb.isPromptInFlightForSession(session);
  if (session.isStreaming || inFlight) {
    await session.prompt(text, { streamingBehavior: "steer" });
    return { status: "queued", message: `Queued slash command: ${text}` };
  }

  piWeb.setPromptInFlightForSession(session, true);
  void session
    .prompt(text)
    .catch((err: any) => {
      if (piWeb.isSessionActive(session)) {
        piWeb.wsManager.broadcast({
          type: "prompt_error",
          data: { message: err?.message || String(err) },
        });
      }
    })
    .finally(() => {
      piWeb.setPromptInFlightForSession(session, false);
    });

  return { status: "sent", message: `Executed slash command: ${text}` };
}

export function registerCommandRoutes(app: Hono, piWebApp: PiWebApp) {
  const getApp = (c: any): PiWebApp => c._app as PiWebApp;

  app.get("/api/commands", async (c) => {
    try {
      const piWeb = getApp(c);
      const session = await piWeb.getSessionForFile(c.req.query("sessionFile") || undefined);
      return c.json({ commands: sessionCommands(session) });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/api/commands/execute", async (c) => {
    try {
      const piWeb = getApp(c);
      const body = await c.req.json().catch(() => ({}));
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text.startsWith("/")) return c.json({ error: "Slash command required" }, 400);

      const parsed = parseCommand(text);
      if (!parsed || !parsed.name) return c.json({ error: "Invalid slash command" }, 400);

      const session = await piWeb.getSessionForFile(body.sessionFile);
      const builtin = BUILTIN_COMMANDS.find((command) => command.name === parsed.name);

      if (!builtin) {
        const result = await startSlashPrompt(piWeb, session, text);
        return c.json({ ...result, action: "agent" });
      }

      switch (parsed.name) {
        case "settings":
        case "scoped-models":
          return c.json({ status: "ok", action: "open_settings", message: "Opened settings." });

        case "model": {
          if (!parsed.args) {
            return c.json({ status: "ok", action: "open_settings", message: "Open Settings to select a model, or run /model provider/model." });
          }
          const [provider, ...modelParts] = parsed.args.split("/");
          const modelId = modelParts.join("/");
          if (!provider || !modelId) {
            return c.json({ status: "error", message: "Usage: /model provider/model" }, 400);
          }
          const model = session.modelRegistry.find(provider, modelId);
          if (!model) return c.json({ status: "error", message: `Model not found: ${parsed.args}` }, 404);
          await session.setModel(model);
          return c.json({ status: "ok", message: `Model selected: ${provider}/${modelId}` });
        }

        case "new": {
          const result = await piWeb.createNewRuntimeSession();
          return c.json({ status: result.cancelled ? "cancelled" : "ok", action: "session_changed", sessionFile: result.sessionFile, message: "New session started." });
        }

        case "name": {
          if (!parsed.args) {
            const currentName = session.sessionManager.getSessionName();
            return c.json({ status: "ok", message: currentName ? `Session name: ${currentName}` : "Usage: /name <name>" });
          }
          session.setSessionName(parsed.args);
          return c.json({ status: "ok", message: `Session name set: ${parsed.args}` });
        }

        case "session":
          return c.json({ status: "ok", message: formatSessionStats(session) });

        case "copy": {
          const text = session.getLastAssistantText();
          if (!text) return c.json({ status: "error", message: "No agent messages to copy yet." }, 404);
          return c.json({ status: "ok", action: "copy_to_clipboard", text, message: "Copied last assistant message." });
        }

        case "export": {
          const outputPath = parsed.args || undefined;
          const filePath = outputPath?.endsWith(".jsonl")
            ? session.exportToJsonl(outputPath)
            : await session.exportToHtml(outputPath);
          return c.json({ status: "ok", message: `Session exported to: ${filePath}` });
        }

        case "compact": {
          if (session.isCompacting) return c.json({ status: "busy", message: "Compaction is already running." }, 409);
          void session.compact(parsed.args || undefined).catch(() => undefined);
          return c.json({ status: "sent", message: "Compaction started." });
        }

        case "reload": {
          if (session.isStreaming || session.isCompacting) {
            return c.json({ status: "busy", message: "Wait for the current response/compaction to finish before reloading." }, 409);
          }
          await session.reload();
          return c.json({ status: "ok", message: "Reloaded keybindings, extensions, skills, prompts, and themes." });
        }

        case "hotkeys":
          return c.json({ status: "ok", message: "Web shortcuts: Enter sends on desktop, Shift+Enter inserts newline, paperclip attaches files/images. pi TUI hotkeys are terminal-only." });

        case "resume":
          return c.json({ status: "ok", action: "open_sessions", message: "Open Sessions to resume a different session." });

        case "tree":
        case "fork":
        case "clone":
          return c.json({ status: "unsupported", message: `/${parsed.name} requires the pi tree/fork selector UI and is not implemented in web yet.` }, 501);

        case "login":
        case "logout":
          return c.json({ status: "unsupported", message: `/${parsed.name} manages provider OAuth in the terminal UI. Use the pi CLI for provider auth.` }, 501);

        case "share":
        case "import":
        case "changelog":
          return c.json({ status: "unsupported", message: `/${parsed.name} is not implemented in web yet.` }, 501);

        case "quit":
          return c.json({ status: "unsupported", message: "/quit is disabled in pi-web for safety." }, 403);
      }

      return c.json({ status: "unsupported", message: `Unsupported command: /${parsed.name}` }, 501);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}
