/**
 * Message routes
 * GET  /api/messages         - Get all messages for current session
 * POST /api/messages/prompt  - Send a prompt
 * POST /api/messages/steer   - Steer current turn
 * POST /api/messages/followup - Queue follow-up
 * POST /api/messages/abort   - Abort current streaming
 */

import type { Hono } from "hono";
import type { PiWebApp } from "../app.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

function isSerializableMessageEntry(entry: any): boolean {
  if (entry?.type !== "message") return false;
  const role = entry.message?.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

export function getSerializedMessagesForSessionManager(sm: any): any[] {
  const entries = sm.getEntries();

  return entries
    .filter((entry: any) => isSerializableMessageEntry(entry))
    .map((entry: any) => serializeMessageEntry(entry));
}

export function getSerializedMessageTailForSessionManager(sm: any, maxMessages = 120): any[] {
  const entries = sm.getEntries();
  const tail: any[] = [];
  for (let i = entries.length - 1; i >= 0 && tail.length < maxMessages; i--) {
    const entry = entries[i];
    if (isSerializableMessageEntry(entry)) tail.push(entry);
  }
  return tail.reverse().map((entry) => serializeMessageEntry(entry));
}

export function getSerializedMessageTailFromSessionFile(sessionFile: string, maxMessages = 120): any[] {
  const stat = statSync(sessionFile);
  const fd = openSync(sessionFile, "r");
  const chunkSize = 128 * 1024;
  let position = stat.size;
  let buffer = "";
  const entries: any[] = [];

  try {
    while (position > 0 && entries.length < maxMessages) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.allocUnsafe(readSize);
      readSync(fd, chunk, 0, readSize, position);
      buffer = chunk.toString("utf8") + buffer;

      const lines = buffer.split("\n");
      // Keep the first line as it may be partial when reading from the middle of the file.
      buffer = position > 0 ? (lines.shift() ?? "") : "";

      for (let i = lines.length - 1; i >= 0 && entries.length < maxMessages; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const role = entry?.message?.role;
          if (entry?.type === "message" && (role === "user" || role === "assistant" || role === "toolResult")) {
            entries.push(entry);
          }
        } catch {
          // Ignore partial/corrupt tail lines.
        }
      }
    }
  } finally {
    closeSync(fd);
  }

  return entries.reverse().map((entry) => serializeMessageEntry(entry));
}

function appendStreamingMessage(session: AgentSession, messages: any[]): any[] {
  // While streaming, the current assistant message lives in agent.state.streamingMessage
  // and may not be flushed to the session file yet. Include it for instant session switching.
  const streamingMessage = (session.agent as any)?.state?.streamingMessage;
  if (streamingMessage && streamingMessage.role === "assistant") {
    messages.push(serializeMessageEntry({
      id: "__streaming_current__",
      type: "message",
      message: streamingMessage,
      timestamp: streamingMessage.timestamp,
      isStreaming: true,
    }));
  }
  return messages;
}

export function getSerializedMessagesForSession(session: AgentSession): any[] {
  return appendStreamingMessage(session, getSerializedMessagesForSessionManager(session.sessionManager));
}

export function getSerializedMessageTailForSession(session: AgentSession, maxMessages = 120): any[] {
  const messages = appendStreamingMessage(
    session,
    getSerializedMessageTailForSessionManager(session.sessionManager, maxMessages),
  );
  return messages.slice(-maxMessages);
}

interface IncomingAttachment {
  name: string;
  mimeType?: string;
  size?: number;
  data: string;
  kind?: "image" | "file";
}

const MAX_ATTACHMENTS = 10;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function sanitizeFileName(name: string): string {
  const base = path.basename(name || "upload.bin");
  return base.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120) || "upload.bin";
}

function stripDataUrl(data: string): string {
  const comma = data.indexOf(",");
  if (data.startsWith("data:") && comma !== -1) return data.slice(comma + 1);
  return data;
}

function uploadRootForSession(session: AgentSession): string {
  return path.join(
    process.env.HOME || "/tmp",
    ".pi",
    "uploads",
    "pi-web-remote",
    session.sessionId,
  );
}

function prepareAttachmentsForPrompt(
  session: AgentSession,
  attachments: IncomingAttachment[] | undefined,
): { textPrefix: string; images: ImageContent[] } {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { textPrefix: "", images: [] };
  }

  const limited = attachments.slice(0, MAX_ATTACHMENTS);
  const uploadDir = uploadRootForSession(session);
  mkdirSync(uploadDir, { recursive: true });

  let totalBytes = 0;
  const images: ImageContent[] = [];
  const lines: string[] = [
    "Uploaded attachments were saved locally for tool access.",
    "Use read/bash or vision capabilities as appropriate.",
    "",
  ];

  for (const attachment of limited) {
    if (!attachment?.data || typeof attachment.data !== "string") continue;
    const mimeType = attachment.mimeType || "application/octet-stream";
    const name = sanitizeFileName(attachment.name || "upload.bin");
    const base64 = stripDataUrl(attachment.data);
    const buffer = Buffer.from(base64, "base64");
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`Attachments too large. Max total size is ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB.`);
    }

    const filePath = path.join(uploadDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`);
    writeFileSync(filePath, buffer);

    const isImage = attachment.kind === "image" || mimeType.startsWith("image/");
    if (isImage) {
      images.push({ type: "image", data: base64, mimeType });
    }

    lines.push(
      `- ${name}`,
      `  path: ${filePath}`,
      `  mimeType: ${mimeType}`,
      `  size: ${buffer.length} bytes`,
      isImage ? "  note: attached directly to the model as an image and saved as a local file" : "  note: saved as a local file for tools to inspect",
      "",
    );
  }

  if (lines.length <= 3) return { textPrefix: "", images };
  return {
    textPrefix: `<uploaded_attachments>\n${lines.join("\n")}\n</uploaded_attachments>\n\n`,
    images,
  };
}

export function registerMessageRoutes(app: Hono, piWebApp: PiWebApp) {
  const getApp = (c: any): PiWebApp => c._app as PiWebApp;

  // Get all messages for current session
  app.get("/api/messages", async (c) => {
    try {
      const piWeb = getApp(c);
      const sessionFile = c.req.query("sessionFile") || undefined;
      const tailParam = c.req.query("tail");
      const tail = tailParam ? Math.max(1, Math.min(500, parseInt(tailParam, 10) || 120)) : undefined;
      const full = c.req.query("full") === "1";
      return c.json({ messages: piWeb.getMessagesForSessionFile(sessionFile, { tail, full }) });
    } catch (err: any) {
      if (String(err.message || "").includes("sessionFile")) return c.json({ error: err.message }, 403);
      return c.json({ error: err.message }, 500);
    }
  });

  // Send a prompt
  // If the agent is currently streaming, automatically queue as follow-up
  app.post("/api/messages/prompt", async (c) => {
    try {
      const piWeb = getApp(c);
      const body = await c.req.json();
      const { text, sessionFile, attachments } = body;
      if (!text && (!Array.isArray(attachments) || attachments.length === 0)) {
        return c.json({ error: "Prompt text or attachments required" }, 400);
      }

      // Route the prompt to the session that was visible when the user pressed Send.
      // This prevents a fast session switch from moving the prompt to another session.
      const promptSession = await piWeb.getSessionForFile(sessionFile);
      const { textPrefix, images } = prepareAttachmentsForPrompt(promptSession, attachments);
      const displayText = text || "Please analyze the attached file(s).";
      const promptText = `${textPrefix}${displayText}`;
      const promptInFlight = piWeb.isPromptInFlightForSession(promptSession);

      if (promptSession.isStreaming || promptInFlight) {
        // Agent is busy — queue as follow-up on the captured session.
        await promptSession.followUp(promptText, images);
        if (piWeb.isSessionActive(promptSession)) {
          piWeb.wsManager.broadcast({ type: "prompt_queued", data: { text: displayText, as: "followUp" } });
        }
        return c.json({ status: "queued", as: "followUp" });
      } else {
        // Start long-running agent work in the server process and return immediately.
        // Capture the active session so it can continue in the background even if
        // the user switches to another session while this prompt is running.
        piWeb.setPromptInFlightForSession(promptSession, true);
        if (piWeb.isSessionActive(promptSession)) {
          piWeb.wsManager.broadcast({ type: "prompt_sent", data: { text: displayText } });
        }
        void promptSession
          .prompt(promptText, { images })
          .catch((err: any) => {
            if (piWeb.isSessionActive(promptSession)) {
              piWeb.wsManager.broadcast({
                type: "prompt_error",
                data: { message: err?.message || String(err) },
              });
            }
          })
          .finally(() => {
            piWeb.setPromptInFlightForSession(promptSession, false);
          });
        return c.json({ status: "sent" });
      }
    } catch (err: any) {
      if (String(err.message || "").includes("sessionFile")) return c.json({ error: err.message }, 403);
      return c.json({ error: err.message }, 500);
    }
  });

  // Steer
  app.post("/api/messages/steer", async (c) => {
    try {
      const piWeb = getApp(c);
      const body = await c.req.json();
      const { text, sessionFile, attachments } = body;
      if (!text && (!Array.isArray(attachments) || attachments.length === 0)) {
        return c.json({ error: "Steering text or attachments required" }, 400);
      }

      const session = await piWeb.getSessionForFile(sessionFile);
      const { textPrefix, images } = prepareAttachmentsForPrompt(session, attachments);
      await session.steer(`${textPrefix}${text || "Please analyze the attached file(s)."}`, images);
      return c.json({ status: "steered" });
    } catch (err: any) {
      if (String(err.message || "").includes("sessionFile")) return c.json({ error: err.message }, 403);
      return c.json({ error: err.message }, 500);
    }
  });

  // Follow up
  app.post("/api/messages/followup", async (c) => {
    try {
      const piWeb = getApp(c);
      const body = await c.req.json();
      const { text, sessionFile, attachments } = body;
      if (!text && (!Array.isArray(attachments) || attachments.length === 0)) {
        return c.json({ error: "Follow-up text or attachments required" }, 400);
      }

      const session = await piWeb.getSessionForFile(sessionFile);
      const { textPrefix, images } = prepareAttachmentsForPrompt(session, attachments);
      await session.followUp(`${textPrefix}${text || "Please analyze the attached file(s)."}`, images);
      return c.json({ status: "queued" });
    } catch (err: any) {
      if (String(err.message || "").includes("sessionFile")) return c.json({ error: err.message }, 403);
      return c.json({ error: err.message }, 500);
    }
  });

  // Abort current streaming
  app.post("/api/messages/abort", async (c) => {
    try {
      const piWeb = getApp(c);
      const body = await c.req.json().catch(() => ({}));
      const session = await piWeb.getSessionForFile(body.sessionFile);
      await session.abort();
      return c.json({ status: "aborted" });
    } catch (err: any) {
      if (String(err.message || "").includes("sessionFile")) return c.json({ error: err.message }, 403);
      return c.json({ error: err.message }, 500);
    }
  });
}

function timestampToMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Serialize a pi session message entry for the web client.
 */
function serializeMessageEntry(entry: any): any {
  const msg = entry.message || entry;
  const role = msg.role;
  const messageTimestamp = timestampToMillis(msg.timestamp);
  const entryTimestamp = timestampToMillis(entry.timestamp);
  const isStreaming = entry.isStreaming === true;
  let textContent = "";
  let thinkingContent = "";
  let toolCalls: any[] = [];

  if (typeof msg.content === "string") {
    textContent = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text") {
        textContent += block.text || "";
      } else if (block.type === "thinking") {
        thinkingContent += block.thinking || "";
      } else if (block.type === "toolCall") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.arguments,
        });
      }
    }
  }

  // ToolResult messages
  if (role === "toolResult") {
    let outputText = "";
    if (typeof msg.content === "string") {
      outputText = msg.content;
    } else if (Array.isArray(msg.content)) {
      outputText = msg.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text || "")
        .join("\n");
    }

    return {
      id: entry.id || msg.toolCallId,
      type: entry.type,
      role: "toolResult",
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      content: outputText,
      isError: msg.isError,
      details: msg.details,
      timestamp: messageTimestamp ?? entryTimestamp,
      completedAt: entryTimestamp ?? messageTimestamp,
    };
  }

  return {
    id: entry.id,
    type: entry.type,
    role,
    content: textContent,
    thinkingContent: thinkingContent || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    model: msg.provider && msg.model ? { provider: msg.provider, name: msg.model, id: msg.model } : undefined,
    stopReason: msg.stopReason,
    usage: msg.usage
      ? {
          input: msg.usage.input,
          output: msg.usage.output,
          totalTokens: msg.usage.totalTokens,
          cost: msg.usage.cost?.total,
        }
      : undefined,
    timestamp: messageTimestamp ?? entryTimestamp,
    completedAt: role === "assistant" && !isStreaming ? (entry.completedAt ?? entryTimestamp ?? messageTimestamp) : undefined,
    isStreaming,
  };
}
