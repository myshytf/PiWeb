/**
 * Translates AgentSession events into frontend WebSocket event format.
 *
 * AgentSession events use different field names than the old ExtensionAPI events.
 * This module subscribes to an AgentSession and normalizes events so the
 * frontend doesn't need to change its event handling.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { serializeTokenUsage } from "./token-usage.js";

export interface WsEventData {
  type: string;
  data: unknown;
}

/**
 * Subscribe to all relevant AgentSession events and translate them
 * into frontend-compatible WebSocket events.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToSessionEvents(
  session: AgentSession,
  broadcast: (event: WsEventData) => void,
): () => void {
  const handler = (event: AgentSessionEvent) => {
    const e = event as any;

    switch (e.type) {
      case "agent_start":
        broadcast({ type: "agent_start", data: {} });
        break;

      case "agent_end":
        broadcast({
          type: "agent_end",
          data: { messageCount: e.messages?.length ?? 0, tokenUsage: serializeTokenUsage(session), completedAt: Date.now() },
        });
        broadcast({ type: "usage_update", data: serializeTokenUsage(session) });
        break;

      case "message_start": {
        const msg = e.message || e;
        broadcast({
          type: "message_start",
          data: {
            role: msg.role,
            id: msg.id,
            content: msg.role === "user" && typeof msg.content === "string" ? msg.content : undefined,
          },
        });
        break;
      }

      case "message_update": {
        const update = e.assistantMessageEvent || e;
        if (update.type === "text_delta") {
          broadcast({ type: "text_delta", data: { delta: update.delta } });
        } else if (update.type === "thinking_delta") {
          broadcast({ type: "thinking_delta", data: { delta: update.delta } });
        }
        if (update.partial?.usage) {
          broadcast({ type: "usage_update", data: serializeTokenUsage(session, update.partial.usage) });
        }
        break;
      }

      case "message_end": {
        const msg = e.message || e;
        broadcast({ type: "message_end", data: { role: msg.role, id: msg.id, completedAt: Date.now() } });
        if (msg.usage) {
          broadcast({ type: "usage_update", data: serializeTokenUsage(session, msg.usage) });
        }
        break;
      }

      case "turn_start":
        broadcast({ type: "turn_start", data: { turnIndex: e.turnIndex ?? 0 } });
        break;

      case "turn_end":
        broadcast({ type: "turn_end", data: { turnIndex: e.turnIndex ?? 0, completedAt: Date.now() } });
        broadcast({ type: "usage_update", data: serializeTokenUsage(session, e.message?.usage) });
        break;

      case "tool_execution_start":
        broadcast({
          type: "tool_execution_start",
          data: { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args },
        });
        break;

      case "tool_execution_update":
        broadcast({
          type: "tool_execution_update",
          data: { toolCallId: e.toolCallId, toolName: e.toolName, partialResult: e.partialResult },
        });
        break;

      case "tool_execution_end":
        broadcast({
          type: "tool_execution_end",
          data: { toolCallId: e.toolCallId, toolName: e.toolName, isError: e.isError },
        });
        break;

      case "tool_result": {
        const contentText =
          typeof e.content === "string"
            ? e.content
            : Array.isArray(e.content)
              ? e.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
              : JSON.stringify(e.content);
        broadcast({
          type: "tool_result",
          data: {
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            content: contentText.length > 5000 ? contentText.slice(0, 5000) + "..." : contentText,
            isError: e.isError,
          },
        });
        break;
      }

      case "model_select":
        broadcast({
          type: "model_select",
          data: {
            model: e.model ? { id: e.model.id, provider: e.model.provider, name: e.model.name } : null,
            previousModel: e.previousModel
              ? { id: e.previousModel.id, provider: e.previousModel.provider, name: e.previousModel.name }
              : null,
            source: e.source,
          },
        });
        break;

      case "thinking_level_changed":
      case "thinking_level_select":
        broadcast({
          type: "thinking_level_select",
          data: { level: e.level, previousLevel: e.previousLevel },
        });
        break;

      case "session_start":
        broadcast({
          type: "session_start",
          data: {
            reason: e.reason || "new",
            sessionFile: session.sessionFile ?? null,
          },
        });
        break;

      case "session_shutdown":
        broadcast({ type: "session_shutdown", data: { reason: e.reason } });
        break;

      case "compaction_end":
        // Compaction changes context usage without going through a normal turn_end/agent_end path.
        // Broadcast immediately and once more on the next tick so the session manager has settled.
        broadcast({ type: "usage_update", data: serializeTokenUsage(session) });
        setTimeout(() => {
          broadcast({ type: "usage_update", data: serializeTokenUsage(session) });
        }, 100);
        break;

      case "queue_update":
        broadcast({
          type: "queue_update",
          data: { steering: e.steering, followUp: e.followUp },
        });
        break;
    }
  };

  return session.subscribe(handler);
}