"use client";

import { memo, useEffect, useState } from "react";
import type { ChatMessage as ChatMessageType, ToolCallInfo } from "@/stores/app-store";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Bot, User, Wrench, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface ChatMessageProps {
  message: ChatMessageType;
  /** Show turn separator label for multi-turn assistant messages */
  showTurnLabel?: boolean;
  /** Show completion age on the final visible assistant message. */
  isLastMessage?: boolean;
}

function formatAbsoluteTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function formatCompletionAge(completedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - completedAt) / 1000));
  if (seconds < 5) return "방금 완료";
  if (seconds < 60) return `${seconds}초 전 완료`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전 완료`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 전 완료`;
}

function ChatMessageComponent({ message, showTurnLabel, isLastMessage }: ChatMessageProps) {
  const [showThinking, setShowThinking] = useState(false);
  const [expandedTools, setShowExpandedTools] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLastMessage || message.role !== "assistant" || message.isStreaming || !message.completedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isLastMessage, message.role, message.isStreaming, message.completedAt]);

  const toggleTool = (id: string) => {
    setShowExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (message.role === "user") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--color-accent)] flex items-center justify-center">
          <User size={14} className="text-white" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="text-xs text-[var(--color-text-muted)] mb-1">You</div>
          <div className="text-sm text-[var(--color-text-primary)] whitespace-pre-wrap break-words overflow-wrap-anywhere">
            {typeof message.content === "string" ? message.content : JSON.stringify(message.content)}
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? (message.content as any[]).map((b: any) => b.type === "text" ? b.text : "").join("")
        : "";

    const hasContent = content || message.thinkingContent || (message.toolCalls && message.toolCalls.length > 0);
    const isStreamingEmpty = message.isStreaming && !hasContent;

    // Don't show anything for an empty streaming placeholder that hasn't received content yet
    if (isStreamingEmpty && !message.thinkingContent && !(message.toolCalls && message.toolCalls.length > 0)) {
      return (
        <div className="flex gap-3 py-2">
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--color-bg-active)] flex items-center justify-center">
            <Bot size={14} className="text-[var(--color-accent)]" />
          </div>
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="text-xs text-[var(--color-text-muted)] mb-1">
              {message.model ? `${message.model.provider}/${message.model.name}` : "Assistant"}
            </div>
            <div className="text-sm text-[var(--color-text-secondary)] streaming-cursor">Waiting…</div>
          </div>
        </div>
      );
    }

    return (
      <div className="py-2 overflow-hidden">
        {/* Turn separator for multi-turn */}
        {showTurnLabel && message.turnIndex !== undefined && message.turnIndex > 0 && (
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 border-t border-[var(--color-border)]" />
            <span className="text-[10px] text-[var(--color-text-muted)]">Turn {message.turnIndex + 1}</span>
            <div className="flex-1 border-t border-[var(--color-border)]" />
          </div>
        )}
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--color-bg-active)] flex items-center justify-center">
            <Bot size={14} className="text-[var(--color-accent)]" />
          </div>
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="text-xs text-[var(--color-text-muted)] mb-1 flex flex-wrap items-center gap-1.5">
              <span>{message.model ? `${message.model.provider}/${message.model.name}` : "Assistant"}</span>
              {isLastMessage && !message.isStreaming && message.completedAt && (
                <span title={`완료 시각 ${formatAbsoluteTime(message.completedAt)}`}>
                  · {formatCompletionAge(message.completedAt, now)}
                </span>
              )}
            </div>

            {/* Thinking block */}
            {message.thinkingContent && (
              <div className="mb-2">
                <button
                  onClick={() => setShowThinking(!showThinking)}
                  className="flex items-center gap-1 text-[10px] text-[var(--color-purple)] hover:text-[var(--color-purple)]/80"
                >
                  {showThinking ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  Thinking
                </button>
                {showThinking && (
                  <div className="mt-1 p-2 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                    {message.thinkingContent}
                  </div>
                )}
              </div>
            )}

            {/* Main content */}
            {content && (
              <div className={`text-sm text-[var(--color-text-primary)] markdown-body ${message.isStreaming ? "streaming-cursor" : ""}`}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || "");
                      const codeString = String(children).replace(/\n$/, "");
                      if (match) {
                        return (
                          <SyntaxHighlighter
                            style={oneDark}
                            language={match[1]}
                            PreTag="div"
                            customStyle={{ background: "var(--color-bg-tertiary)", borderRadius: "8px" }}
                          >
                            {codeString}
                          </SyntaxHighlighter>
                        );
                      }
                      return (
                        <code className={className} {...props}>
                          {children}
                        </code>
                      );
                    },
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            )}

            {/* Tool calls */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="mt-2 space-y-2">
                {message.toolCalls.map((tc) => (
                  <ToolCallCard key={tc.id} tool={tc} expanded={expandedTools.has(tc.id)} onToggle={() => toggleTool(tc.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // system or other roles
  return (
    <div className="py-2 overflow-hidden">
      <div className="text-xs text-[var(--color-text-muted)] italic break-words overflow-wrap-anywhere">
        {typeof message.content === "string" ? message.content : JSON.stringify(message.content)}
      </div>
    </div>
  );
}

function ToolCallCard({ tool, expanded, onToggle }: { tool: ToolCallInfo; expanded: boolean; onToggle: () => void }) {
  const statusColor = tool.status === "running"
    ? "text-[var(--color-yellow)]"
    : tool.status === "error"
      ? "text-[var(--color-red)]"
      : "text-[var(--color-green)]";

  const statusIcon = tool.status === "running"
    ? <Loader2 size={12} className="animate-spin" />
    : tool.status === "error"
      ? "✗"
      : "✓";

  // Format args for display
  const argsStr = typeof tool.args === "string"
    ? tool.args
    : JSON.stringify(tool.args, null, 2);

  // Detect diff output for special rendering
  const isDiff = tool.output && (
    tool.name === "edit" ||
    (typeof tool.output === "string" && (tool.output.includes("---") && tool.output.includes("+++")))
  );

  return (
    <div className="tool-card">
      <div className="tool-card-header cursor-pointer" onClick={onToggle}>
        <Wrench size={12} className={statusColor} />
        <span className={`text-xs ${statusColor}`}>
          {typeof statusIcon === "string" ? statusIcon : statusIcon}
        </span>
        <span className="text-[var(--color-text-primary)] font-semibold">{tool.name}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {tool.status === "running" && (
          <span className="text-[10px] text-[var(--color-yellow)] ml-auto">running...</span>
        )}
        {tool.status !== "running" && (
          <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">
            {tool.name === "bash" ? "terminal" : tool.name}
          </span>
        )}
      </div>
      {(expanded || tool.status === "running") && (
        <div className="tool-card-body">
          <div className="text-[var(--color-text-muted)] mb-1">Input:</div>
          <pre className="text-[var(--color-text-secondary)] whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {argsStr.length > 500 ? argsStr.slice(0, 500) + "..." : argsStr}
          </pre>
          {tool.output && (
            <>
              <div className="text-[var(--color-text-muted)] mt-2 mb-1">
                Output{tool.isError ? " (error)" : ""}:
              </div>
              <pre className={`text-[var(--color-text-secondary)] whitespace-pre-wrap break-words max-h-60 overflow-y-auto ${isDiff ? "font-mono text-xs" : ""}`}>
                {tool.output.length > 2000 ? tool.output.slice(0, 2000) + "..." : tool.output}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const ChatMessage = memo(
  ChatMessageComponent,
  (prev, next) => prev.message === next.message && prev.showTurnLabel === next.showTurnLabel && prev.isLastMessage === next.isLastMessage,
);
