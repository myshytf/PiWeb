/**
 * API client for pi-web-remote server
 */

import { getBasicAuthHeader } from "./auth";

const API_BASE = typeof window !== "undefined" ? window.location.origin : "http://localhost:9876";
const WS_BASE = typeof window !== "undefined"
  ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
  : "ws://localhost:9876";

/** Return auth headers for API requests */
function authHeaders(): Record<string, string> {
  const auth = getBasicAuthHeader();
  if (!auth) return {};
  return { Authorization: auth };
}

// --- Types ---

export type SessionActivityStatus = "waiting" | "running" | "idle";

export interface SessionInfo {
  sessionId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  file: string;
  firstMessage?: string | null;
  isStreaming?: boolean;
  isActive?: boolean;
  pendingMessageCount?: number;
  status?: SessionActivityStatus;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
}

export interface TokenUsageValue {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface TokenUsageInfo {
  current: TokenUsageValue | null;
  totals: TokenUsageValue;
  context: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
}

export interface UploadAttachment {
  name: string;
  mimeType: string;
  size: number;
  data: string;
  kind: "image" | "file";
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  argumentHint?: string;
}

export interface SlashCommandResult {
  status: string;
  action?: "agent" | "open_settings" | "open_sessions" | "copy_to_clipboard" | "session_changed";
  message?: string;
  text?: string;
  sessionFile?: string | null;
}

export interface AgentState {
  isStreaming: boolean;
  sessionFile?: string | null;
  cwd: string;
  model: ModelInfo | null;
  thinkingLevel: string;
  tokenUsage?: TokenUsageInfo;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modified: number;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export type UiRequest = {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify";
  createdAt: number;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
};

export type UiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

// --- WS Event types ---

export type WsEvent =
  | { type: "connected"; data: { sessionFile: string | null; cwd: string; isStreaming: boolean; model?: ModelInfo | null; thinkingLevel?: string; tokenUsage?: TokenUsageInfo } }
  | { type: "session_start"; data: { reason: string; sessionFile: string | null; cwd?: string; previousSessionFile?: string | null; isStreaming?: boolean; model?: ModelInfo | null; thinkingLevel?: string; tokenUsage?: TokenUsageInfo; messages?: any[] } }
  | { type: "session_messages"; data: { sessionFile: string | null; messages: any[]; model?: ModelInfo | null; thinkingLevel?: string; tokenUsage?: TokenUsageInfo; reason?: string } }
  | { type: "session_status"; data: { sessionFile: string | null; sessionId: string; cwd: string; isStreaming: boolean; isActive: boolean; pendingMessageCount: number; status: SessionActivityStatus } }
  | { type: "sessions_changed"; data: { sessionFile?: string | null; reason?: string } }
  | { type: "session_shutdown"; data: { reason: string } }
  | { type: "agent_start"; data: {} }
  | { type: "agent_end"; data: { messageCount?: number; tokenUsage?: TokenUsageInfo; completedAt?: number } }
  | { type: "message_start"; data: { role: string; id?: string; content?: string } }
  | { type: "message_update"; data: { role: string; id?: string } }
  | { type: "text_delta"; data: { delta: string } }
  | { type: "thinking_delta"; data: { delta: string } }
  | { type: "message_end"; data: { role: string; id?: string; completedAt?: number } }
  | { type: "turn_start"; data: { turnIndex: number } }
  | { type: "turn_end"; data: { turnIndex: number; completedAt?: number } }
  | { type: "tool_execution_start"; data: { toolCallId: string; toolName: string; args: any } }
  | { type: "tool_execution_update"; data: { toolCallId: string; toolName: string; partialResult: any } }
  | { type: "tool_execution_end"; data: { toolCallId: string; toolName: string; isError: boolean } }
  | { type: "tool_result"; data: { toolCallId: string; toolName: string; content: string; isError: boolean } }
  | { type: "model_select"; data: { model: ModelInfo | null; previousModel: ModelInfo | null; source: string } }
  | { type: "thinking_level_select"; data: { level: string; previousLevel: string } }
  | { type: "queue_update"; data: { steering: string[]; followUp: string[] } }
  | { type: "usage_update"; data: TokenUsageInfo }
  | { type: "ui_request"; data: UiRequest }
  | { type: "ui_request_resolved"; data: { id: string; reason: "responded" | "cancelled" | "timeout" } }
  | { type: "prompt_sent"; data: { text: string } }
  | { type: "prompt_queued"; data: { text: string; as: string } }
  | { type: "prompt_error"; data: { message: string } };

// --- API functions ---

export async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(),
  };
  const mergedOptions: RequestInit = {
    ...options,
    headers: {
      ...headers,
      ...(options?.headers as Record<string, string>),
    },
  };
  const res = await fetch(`${API_BASE}${path}`, { ...mergedOptions, credentials: "same-origin" });
  if (res.status === 401) {
    // Dispatch custom event so the app can redirect to login
    window.dispatchEvent(new CustomEvent("pi-web:unauthorized"));
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Health
  health: () => fetchApi<{ status: string; clients: number; timestamp: number }>("/api/health"),

  // Sessions
  listSessions: (scope: "project" | "both" = "project") =>
    fetchApi<{ project: SessionInfo[]; all: SessionInfo[] }>(`/api/sessions?scope=${scope}`),
  currentSession: () => fetchApi<{
    sessionFile: string | null;
    sessionId: string;
    isStreaming: boolean;
    cwd: string;
    model: ModelInfo | null;
  }>("/api/sessions/current"),
  sessionTree: () => fetchApi<{ tree: any; entries: any[] }>("/api/sessions/tree"),
  newSession: () => fetchApi<{ status: string; message: string }>("/api/sessions/new", { method: "POST" }),
  newSessionWithCwd: (cwd: string) =>
    fetchApi<{ status: string; sessionFile: string; cwd: string }>("/api/sessions/new-with-cwd", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    }),
  switchSession: (sessionFile: string) =>
    fetchApi<{ status: string; message: string }>("/api/sessions/switch", {
      method: "POST",
      body: JSON.stringify({ sessionFile }),
    }),
  prewarmSessions: (sessionFiles: string[], priority = false) =>
    fetchApi<{ status: string; requested?: number; warmed?: number }>("/api/sessions/prewarm", {
      method: "POST",
      body: JSON.stringify({ sessionFiles, priority }),
    }),
  sessionMessages: (sessionFile: string, tail = 120) =>
    fetchApi<{ sessionFile: string; cwd: string; messages: any[] }>(
      `/api/sessions/messages?sessionFile=${encodeURIComponent(sessionFile)}&tail=${tail}`,
    ),

  // Messages
  listMessages: (sessionFile?: string | null, options?: { tail?: number; full?: boolean }) => {
    const params = new URLSearchParams();
    if (sessionFile) params.set("sessionFile", sessionFile);
    if (options?.tail) params.set("tail", String(options.tail));
    if (options?.full) params.set("full", "1");
    const query = params.toString();
    return fetchApi<{ messages: any[] }>(`/api/messages${query ? `?${query}` : ""}`);
  },
  sendPrompt: (text: string, sessionFile?: string | null, attachments?: UploadAttachment[]) =>
    fetchApi<{ status: string; as?: string }>("/api/messages/prompt", {
      method: "POST",
      body: JSON.stringify({ text, sessionFile, attachments }),
    }),
  steer: (text: string, sessionFile?: string | null, attachments?: UploadAttachment[]) =>
    fetchApi<{ status: string }>("/api/messages/steer", {
      method: "POST",
      body: JSON.stringify({ text, sessionFile, attachments }),
    }),
  followUp: (text: string, sessionFile?: string | null, attachments?: UploadAttachment[]) =>
    fetchApi<{ status: string }>("/api/messages/followup", {
      method: "POST",
      body: JSON.stringify({ text, sessionFile, attachments }),
    }),
  abort: (sessionFile?: string | null) =>
    fetchApi<{ status: string }>("/api/messages/abort", {
      method: "POST",
      body: JSON.stringify({ sessionFile }),
    }),

  // Slash commands
  listCommands: (sessionFile?: string | null) => {
    const params = new URLSearchParams();
    if (sessionFile) params.set("sessionFile", sessionFile);
    const query = params.toString();
    return fetchApi<{ commands: SlashCommandInfo[] }>(`/api/commands${query ? `?${query}` : ""}`);
  },
  executeCommand: (text: string, sessionFile?: string | null) =>
    fetchApi<SlashCommandResult>("/api/commands/execute", {
      method: "POST",
      body: JSON.stringify({ text, sessionFile }),
    }),

  // Settings
  getSettings: () =>
    fetchApi<{
      model: ModelInfo | null;
      thinkingLevel: string;
      activeTools: string[];
    }>("/api/settings"),
  listModels: () => fetchApi<{ models: ModelInfo[]; current: ModelInfo | null }>("/api/settings/models"),
  setModel: (provider: string, id: string) =>
    fetchApi<{ status: string; model: ModelInfo; thinkingLevel?: string }>("/api/settings/model", {
      method: "POST",
      body: JSON.stringify({ provider, id }),
    }),
  setThinkingLevel: (level: string) =>
    fetchApi<{ status: string; level: string }>("/api/settings/thinking", {
      method: "POST",
      body: JSON.stringify({ level }),
    }),

  // Agent state
  agentState: () => fetchApi<AgentState>("/api/agent/state"),

  // Tools
  listTools: () => fetchApi<{ tools: any[]; activeCount: number; totalCount: number }>("/api/tools"),

  // Files
  listFiles: (path?: string) =>
    fetchApi<{ path: string; entries: FileEntry[] }>(`/api/files/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  readFile: (path: string) =>
    fetchApi<{ path: string; content: string; size: number; modified: number; extension: string }>(`/api/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    fetchApi<{ status: string; path: string; size: number }>("/api/files/write", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),
  fileTree: (path?: string, depth?: number) =>
    fetchApi<FileNode>(`/api/files/tree${path ? `?path=${encodeURIComponent(path)}&depth=${depth ?? 2}` : ""}`),

  // Headless extension UI bridge
  pendingUiRequests: () => fetchApi<{ requests: UiRequest[] }>("/api/ui/pending"),
  respondUiRequest: (response: UiResponse) =>
    fetchApi<{ status: string }>("/api/ui/respond", {
      method: "POST",
      body: JSON.stringify(response),
    }),
  cancelUiRequest: (id: string) =>
    fetchApi<{ status: string }>("/api/ui/cancel", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  // Events
  eventSnapshot: () => fetchApi<{
    sessionFile: string | null;
    cwd: string;
    isStreaming: boolean;
  }>("/api/events/snapshot"),
};

// --- WebSocket ---

/**
 * Return a WebSocket URL.
 * Authentication is handled by the server-issued HttpOnly login cookie; do not
 * put credentials in the query string because URLs are commonly logged.
 */
function wsUrl(): string {
  const params = new URLSearchParams();

  if (typeof window !== "undefined") {
    const urlSession = new URLSearchParams(window.location.search).get("session");
    const lastViewedSession = localStorage.getItem("pi_web_last_viewed_session");
    const desiredSession = urlSession || lastViewedSession;
    if (desiredSession) params.set("session", desiredSession);
  }

  const query = params.toString();
  return `${WS_BASE}/ws${query ? `?${query}` : ""}`;
}

export function createWsConnection(onEvent: (event: WsEvent) => void): {
  close: () => void;
  reconnect: () => void;
  connected: boolean;
} {
  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 10000;
  const BASE_DELAY = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  let intentionalClose = false;

  function getReconnectDelay(): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, 10s (max)
    const delay = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    return delay;
  }

  function connect() {
    if (intentionalClose) return;

    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      connected = true;
      reconnectAttempts = 0; // Reset backoff on successful connection
      console.log("[pi-web] WebSocket connected");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsEvent;
        // Reset reconnect attempts on any message (connection is healthy)
        reconnectAttempts = 0;
        onEvent(data);
      } catch (e) {
        console.error("[pi-web] Failed to parse WS message", e);
      }
    };

    ws.onclose = () => {
      const wasConnected = connected;
      connected = false;
      if (intentionalClose) {
        console.log("[pi-web] WebSocket closed intentionally");
        return;
      }
      console.log(`[pi-web] WebSocket disconnected (was ${wasConnected ? "connected" : "connecting"}), reconnecting...`);
      // Auto-reconnect with backoff
      const delay = getReconnectDelay();
      reconnectTimer = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      connected = false;
    };
  }

  function forceReconnect() {
    // Immediate reconnect — used when app comes back from background
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
    if (ws) {
      ws.onclose = null; // Prevent auto-reconnect from onclose
      ws.close();
    }
    connect();
  }

  function close() {
    intentionalClose = true;
    connected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
  }

  connect();

  return {
    close,
    reconnect: forceReconnect,
    get connected() { return connected; },
  };
}
