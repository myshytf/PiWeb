import { create } from "zustand";
import type { WsEvent, ModelInfo, SessionInfo, TokenUsageInfo, UiRequest, UiResponse, UploadAttachment } from "../lib/api";
import { api } from "../lib/api";

// --- Message types ---

export interface ToolCallInfo {
  id: string;
  name: string;
  args: any;
  status: "running" | "completed" | "error";
  output?: string;
  isError?: boolean;
  startTime: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  completedAt?: number;
  model?: ModelInfo;
  isStreaming?: boolean;
  thinkingContent?: string;
  toolCalls?: ToolCallInfo[];
  turnIndex?: number;
}

export interface FileContextItem {
  path: string;
  name: string;
  content: string;
  size: number;
}

interface AppState {
  // Connection
  connected: boolean;
  wsConnecting: boolean;

  // Session
  sessionId: string | null;
  sessionFile: string | null;
  cwd: string | null;

  // Messages - each turn creates a separate assistant message
  messages: ChatMessage[];
  isStreaming: boolean;

  // Track pending follow-up messages that haven't appeared in session yet
  pendingFollowUps: string[];
  currentTurnMessageId: string | null;

  // Headless extension UI requests
  pendingUiRequests: UiRequest[];

  // Model
  currentModel: ModelInfo | null;
  availableModels: ModelInfo[];
  thinkingLevel: string;

  // Usage
  tokenUsage: TokenUsageInfo | null;
  streamingOutputEstimate: number;

  // Sessions list
  sessions: SessionInfo[];

  // File browser
  fileBrowserPath: string;
  fileBrowserEntries: any[];
  fileContent: string | null;
  fileContentPath: string | null;
  selectedFileContexts: FileContextItem[];

  // Settings panel
  settingsOpen: boolean;
  sessionsPanelOpen: boolean;
  fileBrowserOpen: boolean;

  // Actions
  handleWsEvent: (event: WsEvent) => void;
  sendPrompt: (text: string, attachments?: UploadAttachment[]) => Promise<void>;
  executeSlashCommand: (text: string) => Promise<void>;
  sendSteer: (text: string) => Promise<void>;
  sendFollowUp: (text: string) => Promise<void>;
  abortStreaming: () => Promise<void>;
  loadMessages: () => Promise<void>;
  loadModels: () => Promise<void>;
  loadSessions: () => Promise<void>;
  loadPendingUiRequests: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadAgentState: () => Promise<void>;
  respondUiRequest: (response: UiResponse) => Promise<void>;
  cancelUiRequest: (id: string) => Promise<void>;
  dismissUiRequest: (id: string) => void;
  setModel: (provider: string, id: string) => Promise<void>;
  switchSession: (sessionFile: string) => Promise<void>;
  createNewSession: () => Promise<void>;
  createNewSessionWithCwd: (cwd: string) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  listFiles: (path?: string) => Promise<void>;
  readFile: (path: string) => Promise<void>;
  addSelectedFileToContext: () => void;
  removeFileContext: (path: string) => void;
  clearFileContexts: () => void;
  setSettingsOpen: (open: boolean) => void;
  setSessionsPanelOpen: (open: boolean) => void;
  setFileBrowserOpen: (open: boolean) => void;
}

let nextId = 1;
const LAST_VIEWED_SESSION_KEY = "pi_web_last_viewed_session";

function loadLastViewedSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(LAST_VIEWED_SESSION_KEY);
  } catch {
    return null;
  }
}

function saveLastViewedSession(sessionFile: string | null | undefined): void {
  if (typeof window === "undefined" || !sessionFile) return;
  try {
    localStorage.setItem(LAST_VIEWED_SESSION_KEY, sessionFile);
  } catch {
    // ignore
  }
}

let loadMessagesInFlight: { sessionFile: string | null; promise: Promise<void> } | null = null;
let messageCacheBySessionFile = new Map<string, ChatMessage[]>();
let optimisticMessagesBySessionFile = new Map<string, ChatMessage[]>();
let loadSessionsInFlight: Promise<void> | null = null;
let hydrateAllSessionsTimer: ReturnType<typeof setTimeout> | null = null;
const bulkPrewarmRequested = new Set<string>();

function cacheMessagesForSession(sessionFile: string | null | undefined, messages: ChatMessage[]): void {
  if (!sessionFile) return;
  messageCacheBySessionFile.set(sessionFile, messages);
  if (messageCacheBySessionFile.size > 30) {
    const firstKey = messageCacheBySessionFile.keys().next().value;
    if (firstKey) messageCacheBySessionFile.delete(firstKey);
  }
}

function mergeOptimisticMessages(sessionFile: string | null | undefined, serverMessages: ChatMessage[]): ChatMessage[] {
  if (!sessionFile) return serverMessages;
  const optimistic = optimisticMessagesBySessionFile.get(sessionFile) ?? [];
  if (optimistic.length === 0) return serverMessages;

  const merged = [...serverMessages];
  const remaining: ChatMessage[] = [];

  for (const localMsg of optimistic) {
    const alreadyOnServer = serverMessages.some((msg) =>
      msg.role === localMsg.role &&
      msg.content === localMsg.content &&
      Math.abs((msg.timestamp ?? 0) - (localMsg.timestamp ?? 0)) < 10 * 60 * 1000
    );

    if (!alreadyOnServer) {
      merged.push(localMsg);
      remaining.push(localMsg);
    }
  }

  if (remaining.length > 0) optimisticMessagesBySessionFile.set(sessionFile, remaining);
  else optimisticMessagesBySessionFile.delete(sessionFile);

  return merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}
let settingsMutationSeq = 0;

function genId() {
  return `msg-${Date.now()}-${nextId++}`;
}

function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Helper to update a message in the messages array by id.
 * Returns a new array with the message at `id` replaced by the result of `updater`.
 */
function updateMessageById(
  messages: ChatMessage[],
  id: string,
  updater: (msg: ChatMessage) => ChatMessage
): ChatMessage[] {
  return messages.map((m) => (m.id === id ? updater(m) : m));
}

function createStreamingAssistantMessage(model: ModelInfo | null, turnIndex = 0): ChatMessage {
  return {
    id: genId(),
    role: "assistant",
    content: "",
    thinkingContent: "",
    toolCalls: [],
    isStreaming: true,
    turnIndex,
    model: model ?? undefined,
    timestamp: Date.now(),
  };
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function escapeFilePathAttribute(path: string): string {
  return path
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeFileContextContent(content: string): string {
  return content.replaceAll("</file>", "<\\/file>");
}

export function buildPromptWithFileContexts(text: string, contexts: FileContextItem[]): string {
  if (contexts.length === 0) return text;
  const blocks = contexts.map((ctx) => {
    const content = ctx.content.length > 20000
      ? `${ctx.content.slice(0, 20000)}\n... (truncated)`
      : ctx.content;
    return `<file path="${escapeFilePathAttribute(ctx.path)}">\n${escapeFileContextContent(content)}\n</file>`;
  });
  return `${blocks.join("\n\n")}\n\nUser request:\n${text}`;
}

export function displayContentForUserMessage(content: string): string {
  const match = content.match(/^<file path="[^"]*">[\s\S]*<\/file>\n\nUser request:\n([\s\S]*)$/);
  return match ? match[1] : content;
}

function rawMessagesToChatMessages(rawMessages: any[]): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  const toolCallIndex = new Map<string, ToolCallInfo>();
  const toolNameIndex = new Map<string, ToolCallInfo>();
  let turnIndex = 0;

  for (const m of rawMessages) {
    if (m.role === "user") {
      msgs.push({
        id: m.id || genId(),
        role: "user",
        content: typeof m.content === "string" ? displayContentForUserMessage(m.content) : JSON.stringify(m.content),
        timestamp: m.timestamp,
      });
    } else if (m.role === "assistant") {
      const content = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
          : "";

      const thinkingContent = m.thinkingContent || undefined;
      const toolCalls: ToolCallInfo[] | undefined = m.toolCalls
        ? m.toolCalls.map((tc: any) => ({
            id: tc.id,
            name: tc.name,
            args: tc.arguments || tc.args,
            status: "completed" as const,
            output: undefined,
            startTime: m.timestamp || Date.now(),
          }))
        : undefined;

      if (toolCalls) {
        for (const tc of toolCalls) {
          if (tc.id) toolCallIndex.set(tc.id, tc);
          if (tc.name) toolNameIndex.set(tc.name, tc);
        }
      }

      msgs.push({
        id: m.id || genId(),
        role: "assistant",
        content,
        thinkingContent,
        toolCalls,
        model: m.model || undefined,
        isStreaming: m.isStreaming === true,
        turnIndex,
        timestamp: m.timestamp,
        completedAt: m.completedAt,
      });
      turnIndex++;
    } else if (m.role === "toolResult") {
      const tc = (m.toolCallId ? toolCallIndex.get(m.toolCallId) : undefined)
        ?? (m.toolName ? toolNameIndex.get(m.toolName) : undefined);
      if (tc) {
        tc.output = typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
            : JSON.stringify(m.content);
        tc.isError = m.isError;
      }
    }
  }

  return msgs;
}

export const useAppStore = create<AppState>((set, get) => ({ 
  connected: false,
  wsConnecting: true,
  sessionId: null,
  sessionFile: null,
  cwd: null,
  messages: [],
  isStreaming: false,
  pendingFollowUps: [],
  currentTurnMessageId: null,
  pendingUiRequests: [],
  currentModel: null,
  availableModels: [],
  thinkingLevel: "medium",
  tokenUsage: null,
  streamingOutputEstimate: 0,
  sessions: [],
  fileBrowserPath: "",
  fileBrowserEntries: [],
  fileContent: null,
  fileContentPath: null,
  selectedFileContexts: [],
  settingsOpen: false,
  sessionsPanelOpen: false,
  fileBrowserOpen: false,

  handleWsEvent: (event: WsEvent) => {
    const scopedLiveEvents = new Set([
      "agent_start",
      "agent_end",
      "message_start",
      "message_update",
      "text_delta",
      "thinking_delta",
      "message_end",
      "turn_start",
      "turn_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "tool_result",
      "model_select",
      "thinking_level_select",
      "queue_update",
      "usage_update",
      "prompt_sent",
      "prompt_queued",
      "prompt_error",
    ]);
    const eventSessionFile = (event as any).data?.sessionFile;
    if (
      scopedLiveEvents.has(event.type) &&
      eventSessionFile &&
      get().sessionFile &&
      eventSessionFile !== get().sessionFile
    ) {
      return;
    }

    switch (event.type) {
      case "connected": {
        const currentSession = get().sessionFile;
        const urlSession = typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("session")
          : null;
        const preferredSession = urlSession ?? currentSession ?? loadLastViewedSession();
        const shouldRestorePreferred = preferredSession && preferredSession !== event.data.sessionFile;

        set({
          connected: true,
          wsConnecting: false,
          sessionFile: shouldRestorePreferred ? preferredSession : event.data.sessionFile,
          cwd: shouldRestorePreferred ? get().cwd : (event.data.cwd ?? get().cwd),
          // Only trust connected snapshot if it belongs to the session we intend to show.
          isStreaming: shouldRestorePreferred ? get().isStreaming : (event.data.isStreaming ?? get().isStreaming),
          currentModel: shouldRestorePreferred ? get().currentModel : (event.data.model ?? get().currentModel),
          thinkingLevel: shouldRestorePreferred ? get().thinkingLevel : (event.data.thinkingLevel ?? get().thinkingLevel),
          tokenUsage: shouldRestorePreferred ? get().tokenUsage : (event.data.tokenUsage ?? get().tokenUsage),
        });

        if (shouldRestorePreferred) {
          // Reassert the user's viewed session after reconnect/focus. Do not let server global active
          // session (possibly a background running session) hijack the UI.
          void get().switchSession(preferredSession);
        } else {
          void get().loadMessages().then(() => {
            const state = get();
            const loadedStreamingMessage = [...state.messages]
              .reverse()
              .find((m) => m.role === "assistant" && m.isStreaming);
            const hasCurrentTurn = state.currentTurnMessageId
              ? state.messages.some((m) => m.id === state.currentTurnMessageId)
              : false;

            if (loadedStreamingMessage) {
              set({ currentTurnMessageId: loadedStreamingMessage.id });
            } else if (state.isStreaming && !hasCurrentTurn) {
              const placeholder = createStreamingAssistantMessage(state.currentModel);
              set((s) => ({
                currentTurnMessageId: placeholder.id,
                messages: [...s.messages, placeholder],
              }));
            }
          });
        }

        get().loadModels();
        get().loadSessions();
        get().loadPendingUiRequests();
        get().loadSettings();
        get().loadAgentState();
        break;
      }

      case "session_start": {
        // Session changed - prefer server-pushed snapshot, then local cache, then background HTTP fallback.
        saveLastViewedSession(event.data.sessionFile);
        const snapshotMessages = event.data.messages
          ? mergeOptimisticMessages(event.data.sessionFile, rawMessagesToChatMessages(event.data.messages))
          : undefined;
        if (event.data.sessionFile && snapshotMessages) {
          cacheMessagesForSession(event.data.sessionFile, snapshotMessages);
        }
        const cachedMessages = event.data.sessionFile
          ? messageCacheBySessionFile.get(event.data.sessionFile)
          : undefined;
        const displayMessages = snapshotMessages ?? cachedMessages ?? [];
        const loadedStreamingMessage = [...displayMessages]
          .reverse()
          .find((m) => m.role === "assistant" && m.isStreaming);

        set({
          sessionFile: event.data.sessionFile ?? get().sessionFile,
          cwd: event.data.cwd ?? get().cwd,
          isStreaming: event.data.isStreaming ?? get().isStreaming,
          currentModel: event.data.model ?? get().currentModel,
          thinkingLevel: event.data.thinkingLevel ?? get().thinkingLevel,
          tokenUsage: event.data.tokenUsage ?? get().tokenUsage,
          messages: displayMessages,
          currentTurnMessageId: loadedStreamingMessage?.id ?? null,
          streamingOutputEstimate: 0,
        });

        // Server will push session_messages shortly if no cached snapshot was ready.
        // Keep /api/messages as a delayed fallback only, so switching itself stays realtime.
        if (!snapshotMessages && !cachedMessages) {
          const targetSessionFile = event.data.sessionFile;
          window.setTimeout(() => {
            if (
              get().sessionFile === targetSessionFile &&
              targetSessionFile &&
              !messageCacheBySessionFile.has(targetSessionFile)
            ) {
              get().loadMessages();
            }
          }, 250);
        }
        if (get().fileBrowserOpen) get().listFiles();
        break;
      }

      case "session_messages": {
        if (!event.data.sessionFile) break;
        const msgs = mergeOptimisticMessages(event.data.sessionFile, rawMessagesToChatMessages(event.data.messages));
        cacheMessagesForSession(event.data.sessionFile, msgs);
        if (get().sessionFile !== event.data.sessionFile) break;
        const streamingMessage = [...msgs].reverse().find((m) => m.role === "assistant" && m.isStreaming);
        set({
          messages: msgs,
          currentTurnMessageId: streamingMessage?.id ?? null,
          currentModel: event.data.model ?? get().currentModel,
          thinkingLevel: event.data.thinkingLevel ?? get().thinkingLevel,
          tokenUsage: event.data.tokenUsage ?? get().tokenUsage,
        });
        break;
      }

      case "sessions_changed":
        void get().loadSessions();
        break;

      case "session_status":
        set((s) => ({
          isStreaming: s.sessionFile === event.data.sessionFile ? event.data.isStreaming : s.isStreaming,
          sessions: s.sessions.map((session) =>
            session.file === event.data.sessionFile
              ? {
                  ...session,
                  isStreaming: event.data.isStreaming,
                  isActive: event.data.isActive,
                  pendingMessageCount: event.data.pendingMessageCount,
                  status: event.data.status,
                }
              : session
          ),
        }));
        break;

      case "agent_start":
        set({ isStreaming: true, currentTurnMessageId: null, streamingOutputEstimate: 0 });
        // Clear pending follow-ups when agent starts processing
        set((s) => ({ pendingFollowUps: [] }));
        break;

      case "agent_end":
        // Finalize any remaining streaming message
        set((s) => {
          const messages = s.currentTurnMessageId
            ? updateMessageById(s.messages, s.currentTurnMessageId, (msg) => ({
                ...msg,
                isStreaming: false,
              completedAt: event.data.completedAt ?? Date.now(),
              }))
            : s.messages;
          return {
            isStreaming: false,
            currentTurnMessageId: null,
            streamingOutputEstimate: 0,
            tokenUsage: event.data.tokenUsage ?? s.tokenUsage,
            messages,
          };
        });
        // Reload messages from server to ensure full history is accurate
        // (catches messages from TUI that weren't broadcast via WS)
        get().loadMessages();
        get().loadAgentState();
        break;

      case "message_start": {
        // For user messages from the TUI (not from web), add them to local state
        if (event.data.role === "user" && event.data.content) {
          // Check if we already have this message (from sendPrompt or loadMessages)
          const msgId = event.data.id;
          if (msgId && !get().messages.some((m) => m.id === msgId)) {
            const userMsg: ChatMessage = {
              id: msgId,
              role: "user",
              content: event.data.content,
              timestamp: Date.now(),
            };
            set((s) => ({ messages: [...s.messages, userMsg] }));
          }
        }
        // For assistant messages, we handle them via turn_start
        break;
      }

      case "turn_start": {
        // Each turn creates a new assistant message segment
        const turnIndex = event.data.turnIndex ?? 0;
        const newMsg = createStreamingAssistantMessage(get().currentModel, turnIndex);

        set((s) => ({
          currentTurnMessageId: newMsg.id,
          messages: [...s.messages, newMsg],
        }));
        break;
      }

      case "text_delta": {
        let turnId = get().currentTurnMessageId;
        if (!turnId || !get().messages.some((m) => m.id === turnId)) {
          const newMsg = createStreamingAssistantMessage(get().currentModel);
          turnId = newMsg.id;
          set((s) => ({ currentTurnMessageId: newMsg.id, messages: [...s.messages, newMsg] }));
        }
        set((s) => ({
          streamingOutputEstimate: s.streamingOutputEstimate + estimateTokensFromText(event.data.delta),
          messages: updateMessageById(s.messages, turnId, (msg) => ({
            ...msg,
            content: (msg.content || "") + event.data.delta,
          })),
        }));
        break;
      }

      case "thinking_delta": {
        let turnId2 = get().currentTurnMessageId;
        if (!turnId2 || !get().messages.some((m) => m.id === turnId2)) {
          const newMsg = createStreamingAssistantMessage(get().currentModel);
          turnId2 = newMsg.id;
          set((s) => ({ currentTurnMessageId: newMsg.id, messages: [...s.messages, newMsg] }));
        }
        set((s) => ({
          messages: updateMessageById(s.messages, turnId2, (msg) => ({
            ...msg,
            thinkingContent: (msg.thinkingContent || "") + event.data.delta,
          })),
        }));
        break;
      }

      case "message_end":
        // Assistant message streaming ended for this turn
        if (event.data.role === "assistant" && get().currentTurnMessageId) {
          const completedAt = event.data.completedAt ?? Date.now();
          set((s) => ({
            messages: updateMessageById(s.messages, get().currentTurnMessageId!, (msg) => ({
              ...msg,
              completedAt,
            })),
          }));
        }
        break;

      case "tool_execution_start": {
        let turnId3 = get().currentTurnMessageId;
        if (!turnId3 || !get().messages.some((m) => m.id === turnId3)) {
          const newMsg = createStreamingAssistantMessage(get().currentModel);
          turnId3 = newMsg.id;
          set((s) => ({ currentTurnMessageId: newMsg.id, messages: [...s.messages, newMsg] }));
        }
        const tc: ToolCallInfo = {
          id: event.data.toolCallId,
          name: event.data.toolName,
          args: event.data.args,
          status: "running",
          startTime: Date.now(),
        };
        set((s) => ({
          messages: updateMessageById(s.messages, turnId3, (msg) => ({
            ...msg,
            toolCalls: [...(msg.toolCalls || []), tc],
          })),
        }));
        break;
      }

      case "tool_execution_update": {
        const turnId4 = get().currentTurnMessageId;
        if (!turnId4) break;
        set((s) => ({
          messages: updateMessageById(s.messages, turnId4, (msg) => ({
            ...msg,
            toolCalls: (msg.toolCalls || []).map((tc) =>
              tc.id === event.data.toolCallId
                ? {
                    ...tc,
                    output: event.data.partialResult
                      ? typeof event.data.partialResult === "string"
                        ? event.data.partialResult
                        : JSON.stringify(event.data.partialResult)
                      : tc.output,
                  }
                : tc
            ),
          })),
        }));
        break;
      }

      case "tool_execution_end": {
        const turnId5 = get().currentTurnMessageId;
        if (!turnId5) break;
        set((s) => ({
          messages: updateMessageById(s.messages, turnId5, (msg) => ({
            ...msg,
            toolCalls: (msg.toolCalls || []).map((tc) =>
              tc.id === event.data.toolCallId
                ? {
                    ...tc,
                    status: event.data.isError ? "error" : "completed",
                    isError: event.data.isError,
                  }
                : tc
            ),
          })),
        }));
        break;
      }

      case "tool_result": {
        const turnId6 = get().currentTurnMessageId;
        if (!turnId6) break;
        set((s) => ({
          messages: updateMessageById(s.messages, turnId6, (msg) => ({
            ...msg,
            toolCalls: (msg.toolCalls || []).map((tc) =>
              tc.id === event.data.toolCallId
                ? { ...tc, output: event.data.content, isError: event.data.isError }
                : tc
            ),
          })),
        }));
        break;
      }

      case "turn_end": {
        // Turn completed - finalize this turn's message
        const turnId6 = get().currentTurnMessageId;
        const completedAt = event.data.completedAt ?? Date.now();
        if (turnId6) {
          set((s) => ({
            messages: updateMessageById(s.messages, turnId6, (msg) => {
              // Clean up empty messages
              const hasContent = msg.content || msg.thinkingContent || (msg.toolCalls && msg.toolCalls.length > 0);
              if (!hasContent) return { ...msg, isStreaming: false, completedAt };
              return {
                ...msg,
                isStreaming: false,
                completedAt,
                // Remove empty thinking/text
                thinkingContent: msg.thinkingContent || undefined,
                toolCalls: msg.toolCalls && msg.toolCalls.length > 0 ? msg.toolCalls : undefined,
              };
            }),
          }));
        }
        // Next turn will create a new message
        set({ currentTurnMessageId: null });
        break;
      }

      case "model_select":
        set({ currentModel: event.data.model });
        break;

      case "thinking_level_select":
        set({ thinkingLevel: event.data.level });
        break;

      case "prompt_sent":
        // User prompt was acknowledged — we already added the user message locally
        break;

      case "prompt_queued":
        // Message was queued because the agent was busy
        set((s) => ({ pendingFollowUps: [...s.pendingFollowUps, event.data.text] }));
        break;

      case "prompt_error":
        console.error("[pi-web-remote] Prompt error:", event.data.message);
        set({ isStreaming: false, streamingOutputEstimate: 0 });
        break;

      case "queue_update":
        break;

      case "usage_update":
        set({ tokenUsage: event.data, streamingOutputEstimate: 0 });
        break;

      case "ui_request": {
        const request = event.data;
        if (["select", "confirm", "input", "editor", "notify"].includes(request.method)) {
          set((s) => ({
            pendingUiRequests: [
              ...s.pendingUiRequests.filter((existing) => existing.id !== request.id),
              request,
            ],
          }));
        }
        break;
      }

      case "ui_request_resolved":
        set((s) => ({
          pendingUiRequests: s.pendingUiRequests.filter((request) => request.id !== event.data.id),
        }));
        break;
    }
  },

  sendPrompt: async (text: string, attachments?: UploadAttachment[]) => {
    const contexts = get().selectedFileContexts;
    const outgoingText = buildPromptWithFileContexts(text, contexts);
    const attachmentSummary = attachments?.length
      ? `\n\n[Attached: ${attachments.map((attachment) => attachment.name).join(", ")}]`
      : "";
    // Add user message to local state immediately
    const userMsg: ChatMessage = {
      id: genId(),
      role: "user",
      content: `${text}${attachmentSummary}`,
      timestamp: Date.now(),
    };
    const sessionFile = get().sessionFile;
    set((s) => {
      const messages = [...s.messages, userMsg];
      cacheMessagesForSession(sessionFile, messages);
      if (sessionFile) {
        optimisticMessagesBySessionFile.set(sessionFile, [
          ...(optimisticMessagesBySessionFile.get(sessionFile) ?? []),
          userMsg,
        ]);
      }
      return { messages };
    });
    set({ isStreaming: true });
    try {
      const result = await api.sendPrompt(outgoingText, sessionFile, attachments);
      set({ selectedFileContexts: [] });
      if (result.as === "followUp") {
        // Message was queued - show it as pending follow-up
        set((s) => ({ pendingFollowUps: [...s.pendingFollowUps, text] }));
      }
    } catch (e) {
      console.error("Failed to send prompt", e);
    }
  },

  executeSlashCommand: async (text: string) => {
    const sessionFile = get().sessionFile;
    try {
      const result = await api.executeCommand(text, sessionFile);
      if (result.action === "open_settings") {
        set({ settingsOpen: true });
      } else if (result.action === "open_sessions") {
        set({ sessionsPanelOpen: true });
      } else if (result.action === "copy_to_clipboard" && result.text && typeof navigator !== "undefined") {
        await navigator.clipboard?.writeText(result.text).catch(() => undefined);
      }

      if (result.status === "sent" || result.status === "queued") {
        set({ isStreaming: true });
      }

      if (result.message) {
        const systemMsg: ChatMessage = {
          id: genId(),
          role: "system",
          content: result.message,
          timestamp: Date.now(),
        };
        set((s) => ({ messages: [...s.messages, systemMsg] }));
      }

      if (result.action === "session_changed") {
        await get().loadSessions();
      }
    } catch (e: any) {
      console.error("Failed to execute slash command", e);
      const systemMsg: ChatMessage = {
        id: genId(),
        role: "system",
        content: `Slash command failed: ${e?.message || String(e)}`,
        timestamp: Date.now(),
      };
      set((s) => ({ messages: [...s.messages, systemMsg] }));
    }
  },

  sendSteer: async (text: string) => {
    await api.steer(text, get().sessionFile);
  },

  sendFollowUp: async (text: string) => {
    await api.followUp(text, get().sessionFile);
  },

  abortStreaming: async () => {
    await api.abort(get().sessionFile);
    set({ isStreaming: false, streamingOutputEstimate: 0 });
    await get().loadAgentState();
  },

  loadMessages: async () => {
    const requestedSessionFile = get().sessionFile;
    if (loadMessagesInFlight?.sessionFile === requestedSessionFile) {
      return loadMessagesInFlight.promise;
    }

    let promise: Promise<void>;
    promise = (async () => {
      try {
        const data = await api.listMessages(requestedSessionFile, { tail: 200 });
        const msgs = mergeOptimisticMessages(requestedSessionFile, rawMessagesToChatMessages(data.messages));

        cacheMessagesForSession(requestedSessionFile, msgs);

        // Discard stale responses if the user switched sessions while this request was in flight.
        if (get().sessionFile !== requestedSessionFile) return;
        const streamingMessage = [...msgs].reverse().find((m) => m.role === "assistant" && m.isStreaming);
        set({ messages: msgs, currentTurnMessageId: streamingMessage?.id ?? null });
      } catch (e) {
        console.error("Failed to load messages", e);
      } finally {
        if (loadMessagesInFlight?.sessionFile === requestedSessionFile) {
          loadMessagesInFlight = null;
        }
      }
    })();

    loadMessagesInFlight = { sessionFile: requestedSessionFile, promise };
    return promise;
  },

  loadModels: async () => {
    const requestSeq = settingsMutationSeq;
    try {
      const data = await api.listModels();
      set((state) => ({
        availableModels: data.models,
        currentModel: requestSeq === settingsMutationSeq ? (data.current ?? null) : state.currentModel,
      }));
    } catch (e) {
      console.error("Failed to load models", e);
    }
  },

  loadSessions: async () => {
    if (loadSessionsInFlight) return loadSessionsInFlight;

    loadSessionsInFlight = (async () => {
      try {
        const mergeSessions = (project: SessionInfo[], all: SessionInfo[]) => {
          const seen = new Set<string>();
          return [...project, ...all]
            .filter((s) => {
              const key = s.sessionId || s.file;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        };
        const prewarmRecent = (sessions: SessionInfo[], count: number) => {
          const warmFiles = sessions
            .filter((session) => session.file && session.file !== get().sessionFile && !bulkPrewarmRequested.has(session.file))
            .slice(0, count)
            .map((session) => session.file);
          if (warmFiles.length > 0) {
            for (const file of warmFiles) bulkPrewarmRequested.add(file);
            void api.prewarmSessions(warmFiles).catch(() => {
              for (const file of warmFiles) bulkPrewarmRequested.delete(file);
            });
          }
        };

        // Fast path: project sessions first. This avoids waiting on listAll() before rendering.
        const projectData = await api.listSessions("project");
        const projectSessions = mergeSessions(projectData.project, []);
        set({ sessions: projectSessions });
        prewarmRecent(projectSessions, 4);

        // Slow path: hydrate all sessions after the first paint / initial interaction window.
        // Running listAll immediately can compete with session switching and prewarm work.
        if (hydrateAllSessionsTimer !== null) {
          clearTimeout(hydrateAllSessionsTimer);
        }
        hydrateAllSessionsTimer = setTimeout(() => {
          hydrateAllSessionsTimer = null;
          void api.listSessions("both").then((data) => {
            const allSessions = mergeSessions(data.project, data.all);
            set({ sessions: allSessions });
            prewarmRecent(allSessions, 6);
          }).catch(() => {
            // Project list is already available.
          });
        }, 1200);
      } catch (e) {
        console.error("Failed to load sessions", e);
      } finally {
        loadSessionsInFlight = null;
      }
    })();

    return loadSessionsInFlight;
  },

  loadPendingUiRequests: async () => {
    try {
      const data = await api.pendingUiRequests();
      set({ pendingUiRequests: data.requests });
    } catch (e) {
      console.error("Failed to load pending UI requests", e);
    }
  },

  loadSettings: async () => {
    const requestSeq = settingsMutationSeq;
    try {
      const data = await api.getSettings();
      if (requestSeq === settingsMutationSeq) {
        set({
          currentModel: data.model ?? get().currentModel,
          thinkingLevel: data.thinkingLevel || get().thinkingLevel,
        });
      }
    } catch (e) {
      console.error("Failed to load settings", e);
    }
  },

  loadAgentState: async () => {
    const requestSeq = settingsMutationSeq;
    try {
      const data = await api.agentState();
      const currentSessionFile = get().sessionFile;
      const sameSession = !currentSessionFile || !data.sessionFile || data.sessionFile === currentSessionFile;

      // Agent state is server-global. On reconnect/focus it must not switch the UI
      // away from the user's selected session to a background running session.
      if (!sameSession) return;

      set({
        isStreaming: data.isStreaming,
        sessionFile: data.sessionFile ?? get().sessionFile,
        cwd: data.cwd ?? get().cwd,
        currentModel: requestSeq === settingsMutationSeq ? (data.model ?? get().currentModel) : get().currentModel,
        thinkingLevel: requestSeq === settingsMutationSeq ? (data.thinkingLevel ?? get().thinkingLevel) : get().thinkingLevel,
        tokenUsage: data.tokenUsage ?? get().tokenUsage,
      });
    } catch (e) {
      console.error("Failed to load agent state", e);
    }
  },

  respondUiRequest: async (response: UiResponse) => {
    try {
      await api.respondUiRequest(response);
      set((s) => ({
        pendingUiRequests: s.pendingUiRequests.filter((request) => request.id !== response.id),
      }));
    } catch (e) {
      console.error("Failed to respond to UI request", e);
      await get().loadPendingUiRequests();
    }
  },

  cancelUiRequest: async (id: string) => {
    try {
      await api.cancelUiRequest(id);
      set((s) => ({
        pendingUiRequests: s.pendingUiRequests.filter((request) => request.id !== id),
      }));
    } catch (e) {
      console.error("Failed to cancel UI request", e);
      await get().loadPendingUiRequests();
    }
  },

  dismissUiRequest: (id: string) => {
    set((s) => ({
      pendingUiRequests: s.pendingUiRequests.filter((request) => request.id !== id),
    }));
  },

  setModel: async (provider: string, id: string) => {
    const mutationSeq = ++settingsMutationSeq;
    const previousModel = get().currentModel;
    const previousThinkingLevel = get().thinkingLevel;
    const selectedModel = get().availableModels.find(
      (model) => model.provider === provider && model.id === id
    );

    // Optimistically update UI so SettingsPanel and StatusBar reflect selection immediately.
    set({
      currentModel: selectedModel ?? {
        id,
        provider,
        name: id,
      },
    });

    try {
      const result = await api.setModel(provider, id);
      if (mutationSeq === settingsMutationSeq) {
        set({
          currentModel: result.model,
          thinkingLevel: result.thinkingLevel ?? get().thinkingLevel,
        });
      }
      // WS model_select / thinking_level_select events may also arrive later; they keep state in sync.
    } catch (e) {
      console.error("Failed to set model", e);
      if (mutationSeq === settingsMutationSeq) {
        set({ currentModel: previousModel, thinkingLevel: previousThinkingLevel });
      }
    }
  },

  switchSession: async (sessionFile: string) => {
    saveLastViewedSession(sessionFile);
    const target = get().sessions.find((session) => session.file === sessionFile);
    const cachedMessages = messageCacheBySessionFile.get(sessionFile);
    const streamingMessage = cachedMessages
      ? [...cachedMessages].reverse().find((m) => m.role === "assistant" && m.isStreaming)
      : undefined;

    // Always switch the visible session immediately, even if the session isn't in the
    // loaded list yet (notification deep links often hit this path).
    set({
      sessionFile,
      cwd: target?.cwd ?? get().cwd,
      isStreaming: target?.isStreaming ?? false,
      ...(cachedMessages
        ? { messages: cachedMessages, currentTurnMessageId: streamingMessage?.id ?? null }
        : { messages: [], currentTurnMessageId: null }),
    });

    // Cold session optimization: render JSONL preview immediately while full runtime activates.
    if (!cachedMessages) {
      void api.sessionMessages(sessionFile, 160).then((data) => {
        if (get().sessionFile !== sessionFile) return;
        const msgs = mergeOptimisticMessages(sessionFile, rawMessagesToChatMessages(data.messages));
        cacheMessagesForSession(sessionFile, msgs);
        const streamingMessage = [...msgs].reverse().find((m) => m.role === "assistant" && m.isStreaming);
        set({ messages: msgs, currentTurnMessageId: streamingMessage?.id ?? null, cwd: data.cwd ?? get().cwd });
      }).catch(() => {
        // Full runtime switch will still provide a snapshot/fallback.
      });
    }

    try {
      await api.switchSession(sessionFile);
      // Session will be updated via WS session_start event with a message snapshot.
    } catch (e) {
      console.error("Failed to switch session", e);
      await get().loadAgentState();
    }
  },

  createNewSession: async () => {
    try {
      await api.newSession();
      // Session will be updated via WS session_start event
    } catch (e) {
      console.error("Failed to create new session", e);
    }
  },

  createNewSessionWithCwd: async (cwd: string) => {
    try {
      const result = await api.newSessionWithCwd(cwd);
      set({ sessionFile: result.sessionFile, cwd: result.cwd });
      await get().loadSessions();
      await get().listFiles();
      // Session will also be updated via WS session_start event
    } catch (e) {
      console.error("Failed to create new session with cwd", e);
    }
  },

  setThinkingLevel: async (level: string) => {
    const mutationSeq = ++settingsMutationSeq;
    const previousThinkingLevel = get().thinkingLevel;
    set({ thinkingLevel: level });
    try {
      const result = await api.setThinkingLevel(level);
      if (mutationSeq === settingsMutationSeq) {
        set({ thinkingLevel: result.level });
      }
    } catch (e) {
      console.error("Failed to set thinking level", e);
      if (mutationSeq === settingsMutationSeq) {
        set({ thinkingLevel: previousThinkingLevel });
      }
    }
  },

  listFiles: async (path?: string) => {
    try {
      const data = await api.listFiles(path);
      set({ fileBrowserPath: data.path, fileBrowserEntries: data.entries });
    } catch (e) {
      console.error("Failed to list files", e);
    }
  },

  readFile: async (path: string) => {
    try {
      const data = await api.readFile(path);
      set({ fileContent: data.content, fileContentPath: data.path });
    } catch (e) {
      console.error("Failed to read file", e);
    }
  },

  addSelectedFileToContext: () => {
    const state = get();
    if (!state.fileContentPath || state.fileContent === null) return;
    const path = state.fileContentPath;
    const content = state.fileContent.length > 20000
      ? state.fileContent.slice(0, 20000)
      : state.fileContent;
    const item: FileContextItem = {
      path,
      name: fileNameFromPath(path),
      content,
      size: state.fileContent.length,
    };
    set((s) => ({
      selectedFileContexts: [
        ...s.selectedFileContexts.filter((ctx) => ctx.path !== path),
        item,
      ],
    }));
  },

  removeFileContext: (path: string) => {
    set((s) => ({
      selectedFileContexts: s.selectedFileContexts.filter((ctx) => ctx.path !== path),
    }));
  },

  clearFileContexts: () => set({ selectedFileContexts: [] }),

  setSettingsOpen: (open: boolean) => set({ settingsOpen: open }),
  setSessionsPanelOpen: (open: boolean) => set({ sessionsPanelOpen: open }),
  setFileBrowserOpen: (open: boolean) => set({ fileBrowserOpen: open }),
}));
