/**
 * Main application class for standalone pi-web.
 *
 * Multi-session design:
 * - Each opened session gets its own AgentSessionRuntime.
 * - Switching sessions only changes the active runtime pointer.
 * - Background sessions keep streaming until they finish.
 */

import { createServer } from "./server.js";
import { createWsManager, type WsClient } from "./ws-manager.js";
import { createRuntime } from "./runtime-factory.js";
import { subscribeToSessionEvents, type WsEventData } from "./agent-events.js";
import { createWebUIBridge, type WebUIBridge } from "./web-ui-bridge.js";
import { serializeTokenUsage } from "./token-usage.js";
import { getSerializedMessagesForSession, getSerializedMessagesForSessionManager, getSerializedMessageTailForSession, getSerializedMessageTailFromSessionFile } from "./routes/messages.js";
import { PushManager } from "./push-manager.js";
import { credentialsValid, getAuthConfig } from "./auth.js";
import { resolveSessionFilePath } from "./security.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

import { WebSocketServer } from "ws";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, watch, type FSWatcher } from "node:fs";
import * as path from "node:path";

export interface AppOptions {
  port: number;
  host: string;
  cwd: string;
  agentDir?: string;
  https?: boolean;
  httpsCert?: string;
  httpsKey?: string;
}

type SessionActivityStatus = "waiting" | "running" | "idle";

interface PersistedSessionActivity {
  status: SessionActivityStatus;
  updatedAt: number;
  sessionId?: string;
  cwd?: string;
}

interface RuntimeContext {
  key: string;
  runtime: any;
  session: AgentSession;
  cwd: string;
  promptInFlight: boolean;
  unsubscribeEvents: (() => void) | null;
  messageSnapshot?: any[];
  messageSnapshotFull: boolean;
  messagesVersion: number;
  snapshotVersion: number;
  snapshotInFlight: boolean;
  liveAssistantId?: string;
  everActivated: boolean;
  lastAccessAt: number;
  disposed: boolean;
  activityStatus: SessionActivityStatus;
  completionTimer?: ReturnType<typeof setTimeout>;
  completionNotificationVersion?: number;
  lastCompletedAt?: number;
  externalWatcher?: FSWatcher;
  externalPollTimer?: ReturnType<typeof setInterval>;
  externalSyncTimer?: ReturnType<typeof setTimeout>;
  externalSyncInFlight: boolean;
  externalFileSize?: number;
  externalFileMtimeMs?: number;
}

export async function bindSessionToWebUI(session: AgentSession, uiBridge: WebUIBridge): Promise<void> {
  await session.bindExtensions({ uiContext: uiBridge.uiContext });
}

function extractTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
  }
  return "";
}

function displayPromptContent(content: string): string {
  const match = content.match(/^<file path="[^"]*">[\s\S]*<\/file>\n\nUser request:\n([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

function truncateForNotification(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function compactCwd(cwd: string): string {
  const home = process.env.HOME;
  const normalized = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `${normalized.startsWith("~") ? "~/" : "/"}…/${parts.slice(-2).join("/")}`;
}

function getSessionDisplayName(session: AgentSession): string {
  const name = session.sessionName?.trim();
  if (name) return name;
  const file = session.sessionFile?.split("/").pop();
  if (file) return file.replace(/\.jsonl$/, "");
  return session.sessionId.slice(0, 8);
}

function getLastUserPrompt(session: AgentSession): string {
  const messages = [...(session.messages as any[])].reverse();
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const text = displayPromptContent(extractTextContent(message.content));
    if (text) return text;
  }
  return "최근 사용자 요청을 찾을 수 없음";
}

function getPersistedSessionStateFile(agentDir?: string): string {
  const dir = agentDir || path.join(process.env.HOME || "/tmp", ".pi", "agent");
  return path.join(dir, "pi-web-remote-session-state.json");
}

function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=") || "";
  }
  return null;
}

function credentialsFromCookie(cookieHeader: string | undefined): { username: string; password: string } | null {
  const value = parseCookieValue(cookieHeader, "pi_web_auth");
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    return { username: decoded.slice(0, colonIdx), password: decoded.slice(colonIdx + 1) };
  } catch {
    return null;
  }
}

function createCompletionPushPayload(ctx: RuntimeContext, completedAt: number): Record<string, unknown> {
  const session = ctx.session;
  const cwd = compactCwd(ctx.cwd);
  const sessionName = truncateForNotification(getSessionDisplayName(session), 64);
  const prompt = truncateForNotification(getLastUserPrompt(session), 140);
  const sessionFile = session.sessionFile ?? null;
  const sessionId = session.sessionId;

  return {
    title: `작업 완료 · ${cwd.split("/").pop() || cwd}`,
    body: `세션: ${sessionName}\n디렉토리: ${cwd}\n요청: ${prompt}`,
    icon: "/icon-192.png",
    tag: `pi-web-remote-${sessionId}`,
    data: {
      url: sessionFile ? `/?session=${encodeURIComponent(sessionFile)}` : "/",
      sessionFile,
      sessionId,
      cwd: ctx.cwd,
      prompt,
      completedAt,
    },
  };
}

function findAvailablePort(host: string, startPort: number, maxAttempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function tryPort(port: number) {
      attempts++;
      const server = createHttpServer();
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempts < maxAttempts) {
          console.log(`[pi-web] Port ${port} in use, trying ${port + 1}...`);
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.on("listening", () => {
        server.close();
        resolve(port);
      });
      server.listen(port, host);
    }
    tryPort(startPort);
  });
}

export class PiWebApp {
  session!: AgentSession;
  wsManager = createWsManager();
  port!: number;
  cwd!: string;
  agentDir!: string;

  runtime: any; // Active AgentSessionRuntime
  uiBridge!: WebUIBridge;
  pushManager = new PushManager();
  private runtimeContexts = new Map<string, RuntimeContext>();
  private persistedSessionActivity = new Map<string, PersistedSessionActivity>();
  private prewarmInFlight = new Map<string, Promise<RuntimeContext>>();
  private prewarmQueue: string[] = [];
  private prewarmActive = 0;
  private readonly prewarmConcurrency = 2;
  private readonly maxIdlePrewarmContexts = 8;
  private readonly maxPrewarmQueueLength = 12;
  private readonly snapshotTailMessages = 200;
  private readonly idlePrewarmTtlMs = 10 * 60 * 1000;
  private activeContextKey: string | null = null;
  private promptInFlightFallback = false;
  private httpServer: any;
  private wss: WebSocketServer | null = null;
  private opts: AppOptions;

  constructor(opts: AppOptions) {
    this.opts = opts;
  }

  private loadPersistedSessionActivity(): void {
    try {
      const file = getPersistedSessionStateFile(this.opts.agentDir);
      if (!existsSync(file)) return;
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") return;
      this.persistedSessionActivity.clear();
      for (const [sessionFile, value] of Object.entries(raw as Record<string, any>)) {
        if (!sessionFile || !value) continue;
        if (!["waiting", "running", "idle"].includes(value.status)) continue;
        // A server restart means anything that was running is no longer running in this process.
        // Keep it as idle so the user can still see it needs review.
        const status: SessionActivityStatus = value.status === "running" ? "idle" : value.status;
        this.persistedSessionActivity.set(sessionFile, {
          status,
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
          sessionId: value.sessionId,
          cwd: value.cwd,
        });
      }
    } catch (err) {
      console.warn("[pi-web] Failed to load persisted session activity:", err);
    }
  }

  private savePersistedSessionActivity(): void {
    try {
      const file = getPersistedSessionStateFile(this.opts.agentDir);
      mkdirSync(path.dirname(file), { recursive: true });
      const payload: Record<string, PersistedSessionActivity> = {};
      for (const [sessionFile, value] of this.persistedSessionActivity.entries()) {
        if (value.status === "waiting") continue;
        payload[sessionFile] = value;
      }
      writeFileSync(file, JSON.stringify(payload, null, 2));
    } catch (err) {
      console.warn("[pi-web] Failed to save persisted session activity:", err);
    }
  }

  private persistSessionActivity(ctx: RuntimeContext, status: SessionActivityStatus): void {
    const sessionFile = ctx.session.sessionFile;
    if (!sessionFile) return;
    ctx.activityStatus = status;
    if (status === "waiting") {
      this.persistedSessionActivity.delete(sessionFile);
    } else {
      this.persistedSessionActivity.set(sessionFile, {
        status,
        updatedAt: Date.now(),
        sessionId: ctx.session.sessionId,
        cwd: ctx.cwd,
      });
    }
    this.savePersistedSessionActivity();
  }

  get runtimeRef() {
    return this.runtime;
  }

  get promptInFlight(): boolean {
    return this.activeContext?.promptInFlight ?? this.promptInFlightFallback;
  }

  set promptInFlight(value: boolean) {
    const ctx = this.activeContext;
    if (ctx) ctx.promptInFlight = value;
    this.promptInFlightFallback = value;
  }

  setPromptInFlightForSession(session: AgentSession, value: boolean): void {
    const key = this.getSessionKey(session);
    const ctx = this.runtimeContexts.get(key) ?? (session.sessionFile ? this.findContextBySessionFile(session.sessionFile) : undefined);
    if (ctx) {
      ctx.promptInFlight = value;
      if (value) this.persistSessionActivity(ctx, "running");
      this.broadcastSessionStatus(ctx);
    }
    if (this.activeContext?.session === session) this.promptInFlightFallback = value;
  }

  isPromptInFlightForSession(session: AgentSession): boolean {
    const key = this.getSessionKey(session);
    const ctx = this.runtimeContexts.get(key) ?? (session.sessionFile ? this.findContextBySessionFile(session.sessionFile) : undefined);
    return ctx?.promptInFlight ?? false;
  }

  async getSessionForFile(sessionFile?: string | null): Promise<AgentSession> {
    if (!sessionFile || sessionFile === this.session?.sessionFile) return this.session;
    const safeSessionFile = this.resolveSessionFilePath(sessionFile);
    const existing = this.findContextBySessionFile(safeSessionFile);
    if (existing) return existing.session;
    const ctx = await this.prewarmSession(safeSessionFile);
    return ctx.session;
  }

  isSessionActive(session: AgentSession): boolean {
    return this.activeContext?.session === session;
  }

  getResolvedAgentDir(): string {
    return path.resolve(this.opts.agentDir || this.agentDir || getAgentDir());
  }

  resolveSessionFilePath(sessionFile: string): string {
    return resolveSessionFilePath(sessionFile, this.getResolvedAgentDir());
  }

  isSessionBusy(session: AgentSession = this.session): boolean {
    const key = this.getSessionKey(session);
    const ctx = this.runtimeContexts.get(key) ?? (session.sessionFile ? this.findContextBySessionFile(session.sessionFile) : undefined);
    return ctx ? this.isContextBusy(ctx) : session.isStreaming;
  }

  private get activeContext(): RuntimeContext | null {
    return this.activeContextKey ? (this.runtimeContexts.get(this.activeContextKey) ?? null) : null;
  }

  private isContextBusy(ctx: RuntimeContext): boolean {
    return Boolean(
      ctx.session.isStreaming ||
      ctx.promptInFlight ||
      ctx.session.pendingMessageCount > 0 ||
      (ctx.session as any).isRetrying,
    );
  }

  private readSessionFileStat(sessionFile: string): { size: number; mtimeMs: number } | null {
    try {
      const stat = statSync(sessionFile);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  private rememberSessionFileStat(ctx: RuntimeContext): void {
    const file = ctx.session.sessionFile;
    if (!file) return;
    const stat = this.readSessionFileStat(file);
    if (!stat) return;
    ctx.externalFileSize = stat.size;
    ctx.externalFileMtimeMs = stat.mtimeMs;
  }

  private hasSessionFileChanged(ctx: RuntimeContext): boolean {
    const file = ctx.session.sessionFile;
    if (!file) return false;
    const stat = this.readSessionFileStat(file);
    if (!stat) return false;
    return stat.size !== ctx.externalFileSize || stat.mtimeMs !== ctx.externalFileMtimeMs;
  }

  private stopExternalSessionFileSync(ctx: RuntimeContext): void {
    if (ctx.externalWatcher) {
      try {
        ctx.externalWatcher.close();
      } catch {
        /* ignore */
      }
      ctx.externalWatcher = undefined;
    }
    if (ctx.externalPollTimer) {
      clearInterval(ctx.externalPollTimer);
      ctx.externalPollTimer = undefined;
    }
    if (ctx.externalSyncTimer) {
      clearTimeout(ctx.externalSyncTimer);
      ctx.externalSyncTimer = undefined;
    }
  }

  private startExternalSessionFileSync(ctx: RuntimeContext): void {
    this.stopExternalSessionFileSync(ctx);
    const file = ctx.session.sessionFile;
    if (!file) return;

    this.rememberSessionFileStat(ctx);

    try {
      ctx.externalWatcher = watch(file, { persistent: false }, () => {
        this.scheduleExternalSessionSync(ctx, "watch");
      });
      ctx.externalWatcher.on("error", () => {
        /* Polling below is the fallback. */
      });
    } catch {
      // fs.watch can fail on some filesystems; polling still keeps the web UI fresh.
    }

    ctx.externalPollTimer = setInterval(() => {
      if (ctx.disposed) return;
      if (this.hasSessionFileChanged(ctx)) {
        this.scheduleExternalSessionSync(ctx, "poll");
      }
    }, 1000);
    (ctx.externalPollTimer as any).unref?.();
  }

  private scheduleExternalSessionSync(ctx: RuntimeContext, reason: string): void {
    if (ctx.disposed || !ctx.session.sessionFile) return;
    if (ctx.externalSyncTimer) clearTimeout(ctx.externalSyncTimer);
    ctx.externalSyncTimer = setTimeout(() => {
      ctx.externalSyncTimer = undefined;
      this.syncSessionFileFromDisk(ctx, reason);
    }, 250);
    (ctx.externalSyncTimer as any).unref?.();
  }

  private inferExternalActivityStatus(messages: any[], fallback: SessionActivityStatus): SessionActivityStatus {
    for (let i = messages.length - 1; i >= 0; i--) {
      const role = messages[i]?.role;
      if (role === "user") return "running";
      if (role === "assistant") return "idle";
    }
    return fallback;
  }

  private syncSessionFileFromDisk(ctx: RuntimeContext, reason: string, force = false): boolean {
    const file = ctx.session.sessionFile;
    if (ctx.disposed || !file || ctx.externalSyncInFlight) return false;
    const stat = this.readSessionFileStat(file);
    if (!stat) return false;

    const changed = force || stat.size !== ctx.externalFileSize || stat.mtimeMs !== ctx.externalFileMtimeMs;
    if (!changed) return false;

    // Do not reload the SessionManager while this web runtime is mutating it.
    // A TUI process can still append to the JSONL file; we pick it up as soon as
    // the web runtime is idle.
    if (this.isContextBusy(ctx)) {
      this.scheduleExternalSessionSync(ctx, `${reason}:busy`);
      return false;
    }

    ctx.externalSyncInFlight = true;
    try {
      ctx.session.sessionManager.setSessionFile(file);
      const sessionContext = ctx.session.sessionManager.buildSessionContext() as any;
      (ctx.session.agent as any).state.messages = sessionContext.messages;

      if (sessionContext.model?.provider && sessionContext.model?.modelId) {
        const model = ctx.session.modelRegistry.find(sessionContext.model.provider, sessionContext.model.modelId);
        if (model) (ctx.session.agent as any).state.model = model;
      }
      if (sessionContext.thinkingLevel) {
        (ctx.session.agent as any).state.thinkingLevel = sessionContext.thinkingLevel;
      }

      const messages = getSerializedMessageTailForSession(ctx.session, this.snapshotTailMessages);
      ctx.messagesVersion++;
      ctx.messageSnapshot = messages;
      ctx.messageSnapshotFull = false;
      ctx.snapshotVersion = ctx.messagesVersion;
      ctx.liveAssistantId = undefined;
      ctx.externalFileSize = stat.size;
      ctx.externalFileMtimeMs = stat.mtimeMs;

      const nextStatus = this.inferExternalActivityStatus(messages, ctx.activityStatus);
      this.persistSessionActivity(ctx, nextStatus);

      this.wsManager.broadcast({
        type: "session_messages",
        data: {
          sessionFile: ctx.session.sessionFile ?? null,
          messages,
          model: ctx.session.model
            ? {
                id: ctx.session.model.id,
                provider: ctx.session.model.provider,
                name: ctx.session.model.name,
                contextWindow: (ctx.session.model as any).contextWindow,
                maxTokens: (ctx.session.model as any).maxTokens,
                reasoning: (ctx.session.model as any).reasoning,
              }
            : null,
          thinkingLevel: ctx.session.thinkingLevel,
          tokenUsage: serializeTokenUsage(ctx.session),
          reason,
        },
      });
      this.wsManager.broadcast({
        type: "sessions_changed",
        data: { sessionFile: ctx.session.sessionFile ?? null, reason: "external_sync" },
      });
      this.broadcastSessionStatus(ctx);
      return true;
    } catch (err: any) {
      console.warn(`[pi-web] Failed to sync session file ${file}:`, err?.message ?? err);
      return false;
    } finally {
      ctx.externalSyncInFlight = false;
      this.rememberSessionFileStat(ctx);
    }
  }

  private getSessionKey(session: AgentSession): string {
    return session.sessionFile ?? session.sessionId;
  }

  private findContextBySessionFile(sessionFile: string): RuntimeContext | undefined {
    for (const ctx of this.runtimeContexts.values()) {
      if (ctx.session.sessionFile === sessionFile) return ctx;
    }
    return undefined;
  }

  getSessionStatuses(): Record<string, { isStreaming: boolean; isActive: boolean; pendingMessageCount: number; sessionId: string; cwd: string; status: SessionActivityStatus }> {
    const statuses: Record<string, { isStreaming: boolean; isActive: boolean; pendingMessageCount: number; sessionId: string; cwd: string; status: SessionActivityStatus }> = {};
    for (const [file, persisted] of this.persistedSessionActivity.entries()) {
      statuses[file] = {
        isStreaming: false,
        isActive: false,
        pendingMessageCount: 0,
        sessionId: persisted.sessionId ?? "",
        cwd: persisted.cwd ?? "",
        status: persisted.status,
      };
    }

    for (const ctx of this.runtimeContexts.values()) {
      const file = ctx.session.sessionFile;
      if (!file) continue;
      const busy = this.isContextBusy(ctx);
      statuses[file] = {
        isStreaming: busy,
        isActive: this.activeContextKey === ctx.key,
        pendingMessageCount: ctx.session.pendingMessageCount,
        sessionId: ctx.session.sessionId,
        cwd: ctx.cwd,
        status: busy ? "running" : ctx.activityStatus,
      };
    }
    return statuses;
  }

  getMessagesForSessionFile(sessionFile?: string, options?: { tail?: number; full?: boolean }): any[] {
    const tail = options?.tail;
    const full = options?.full === true;

    if (!sessionFile || sessionFile === this.session?.sessionFile) {
      if (!full && tail) return getSerializedMessageTailForSession(this.session, tail);
      return getSerializedMessagesForSession(this.session);
    }

    const safeSessionFile = this.resolveSessionFilePath(sessionFile);
    const ctx = this.findContextBySessionFile(safeSessionFile);
    if (ctx) {
      const cached = this.getCachedMessageSnapshot(ctx, full);
      if (cached) return !full && tail ? cached.slice(-tail) : cached;
      if (!full && tail) return getSerializedMessageTailForSession(ctx.session, tail);
      return getSerializedMessagesForSession(ctx.session);
    }

    if (!full && tail) return getSerializedMessageTailFromSessionFile(safeSessionFile, tail);
    const sm = SessionManager.open(safeSessionFile);
    return getSerializedMessagesForSessionManager(sm);
  }

  private getSessionSwitchSnapshot(ctx: RuntimeContext): any[] | undefined {
    const cached = this.getCachedMessageSnapshot(ctx);
    if (cached) return cached.slice(-120);
    const file = ctx.session.sessionFile;
    if (file) {
      try {
        const tail = getSerializedMessageTailFromSessionFile(file, 120);
        // Store the tail as a clean snapshot so future background deltas can update it incrementally.
        ctx.messageSnapshot = tail;
        ctx.messageSnapshotFull = false;
        ctx.snapshotVersion = ctx.messagesVersion;
        return tail;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private broadcastSessionStatus(ctx: RuntimeContext) {
    const busy = this.isContextBusy(ctx);
    this.wsManager.broadcast({
      type: "session_status",
      data: {
        sessionFile: ctx.session.sessionFile ?? null,
        sessionId: ctx.session.sessionId,
        cwd: ctx.cwd,
        isStreaming: busy,
        isActive: this.activeContextKey === ctx.key,
        pendingMessageCount: ctx.session.pendingMessageCount,
        status: busy ? "running" : ctx.activityStatus,
      },
    });
  }

  private broadcastAllSessionStatuses() {
    for (const ctx of this.runtimeContexts.values()) {
      this.broadcastSessionStatus(ctx);
    }
  }

  private clearCompletionTimer(ctx: RuntimeContext): void {
    if (ctx.completionTimer) {
      clearTimeout(ctx.completionTimer);
      ctx.completionTimer = undefined;
    }
  }

  private scheduleCompletionNotification(ctx: RuntimeContext, data: unknown): void {
    this.clearCompletionTimer(ctx);
    const targetVersion = ctx.messagesVersion;
    const eventData = data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) }
      : {};

    ctx.completionTimer = setTimeout(() => {
      this.flushCompletionNotification(ctx, targetVersion, eventData);
    }, 750);
  }

  private flushCompletionNotification(
    ctx: RuntimeContext,
    targetVersion: number,
    eventData: Record<string, unknown>,
  ): void {
    ctx.completionTimer = undefined;
    if (ctx.disposed) return;

    // A newer run/retry/follow-up already produced more events; let its own agent_end decide.
    if (ctx.messagesVersion !== targetVersion) return;

    // agent_end is emitted before AgentSession post-processing/retry/prompt finally handlers settle.
    // Wait until the session is truly idle so notifications do not open a still-running session.
    if (this.isContextBusy(ctx)) {
      ctx.completionTimer = setTimeout(() => {
        this.flushCompletionNotification(ctx, targetVersion, eventData);
      }, 750);
      return;
    }

    if (ctx.completionNotificationVersion === targetVersion) return;
    const completedAt = Date.now();
    ctx.completionNotificationVersion = targetVersion;
    ctx.lastCompletedAt = completedAt;

    this.persistSessionActivity(ctx, "idle");

    if (this.activeContextKey === ctx.key) {
      this.wsManager.broadcast(this.withSessionEvent(ctx, {
        type: "agent_end",
        data: {
          ...eventData,
          completedAt,
          tokenUsage: serializeTokenUsage(ctx.session),
        },
      }));
    }

    this.broadcastSessionStatus(ctx);
    this.warmMessageSnapshot(ctx, false);
    void this.pushManager.sendToAll(createCompletionPushPayload(ctx, completedAt));
  }

  private markMessagesDirty(ctx: RuntimeContext) {
    ctx.messagesVersion++;
  }

  private getCachedMessageSnapshot(ctx: RuntimeContext, requireFull = false): any[] | undefined {
    if (ctx.snapshotVersion !== ctx.messagesVersion) return undefined;
    if (requireFull && !ctx.messageSnapshotFull) return undefined;
    return ctx.messageSnapshot;
  }

  private getCurrentAssistantSnapshot(ctx: RuntimeContext): any | undefined {
    const snapshot = ctx.messageSnapshot;
    if (!snapshot) return undefined;
    if (ctx.liveAssistantId) {
      const byId = snapshot.find((message) => message.id === ctx.liveAssistantId);
      if (byId) return byId;
    }
    for (let i = snapshot.length - 1; i >= 0; i--) {
      if (snapshot[i]?.role === "assistant") return snapshot[i];
    }
    return undefined;
  }

  private createLiveAssistantSnapshot(ctx: RuntimeContext, turnIndex = 0): any {
    if (!ctx.messageSnapshot) ctx.messageSnapshot = [];
    const id = `__live_${ctx.session.sessionId}_${turnIndex}_${Date.now()}`;
    ctx.liveAssistantId = id;
    const model = ctx.session.model
      ? { id: ctx.session.model.id, provider: ctx.session.model.provider, name: ctx.session.model.name }
      : undefined;
    const assistant = {
      id,
      role: "assistant",
      content: "",
      thinkingContent: undefined,
      toolCalls: [],
      model,
      isStreaming: true,
      turnIndex,
      timestamp: Date.now(),
    };
    ctx.messageSnapshot.push(assistant);
    return assistant;
  }

  private findToolCallInSnapshot(ctx: RuntimeContext, toolCallId?: string, toolName?: string): any | undefined {
    const assistant = this.getCurrentAssistantSnapshot(ctx);
    const toolCalls = assistant?.toolCalls;
    if (!Array.isArray(toolCalls)) return undefined;
    return toolCalls.find((tool) =>
      (toolCallId && tool.id === toolCallId) ||
      (toolName && tool.name === toolName)
    );
  }

  private applyEventToMessageSnapshot(ctx: RuntimeContext, event: WsEventData): boolean {
    // Only incremental-update clean snapshots. Dirty/missing snapshots will be rebuilt off the hot path.
    if (!ctx.messageSnapshot || ctx.snapshotVersion !== ctx.messagesVersion) return false;

    const data = event.data as any;
    switch (event.type) {
      case "message_start":
        if (data?.role === "user" && data.content) {
          ctx.messageSnapshot.push({
            id: data.id || `__user_${Date.now()}`,
            role: "user",
            content: data.content,
            timestamp: Date.now(),
          });
        }
        break;

      case "turn_start":
        this.createLiveAssistantSnapshot(ctx, data?.turnIndex ?? 0);
        break;

      case "text_delta": {
        const assistant = this.getCurrentAssistantSnapshot(ctx) ?? this.createLiveAssistantSnapshot(ctx);
        assistant.content = `${assistant.content || ""}${data?.delta || ""}`;
        assistant.isStreaming = true;
        break;
      }

      case "thinking_delta": {
        const assistant = this.getCurrentAssistantSnapshot(ctx) ?? this.createLiveAssistantSnapshot(ctx);
        assistant.thinkingContent = `${assistant.thinkingContent || ""}${data?.delta || ""}`;
        assistant.isStreaming = true;
        break;
      }

      case "tool_execution_start": {
        const assistant = this.getCurrentAssistantSnapshot(ctx) ?? this.createLiveAssistantSnapshot(ctx);
        if (!Array.isArray(assistant.toolCalls)) assistant.toolCalls = [];
        assistant.toolCalls.push({
          id: data?.toolCallId,
          name: data?.toolName,
          args: data?.args,
          status: "running",
          startTime: Date.now(),
        });
        assistant.isStreaming = true;
        break;
      }

      case "tool_execution_update": {
        const tool = this.findToolCallInSnapshot(ctx, data?.toolCallId, data?.toolName);
        if (tool && data?.partialResult !== undefined) {
          tool.output = typeof data.partialResult === "string" ? data.partialResult : JSON.stringify(data.partialResult);
        }
        break;
      }

      case "tool_execution_end": {
        const tool = this.findToolCallInSnapshot(ctx, data?.toolCallId, data?.toolName);
        if (tool) {
          tool.status = data?.isError ? "error" : "completed";
          tool.isError = data?.isError;
        }
        break;
      }

      case "tool_result": {
        const tool = this.findToolCallInSnapshot(ctx, data?.toolCallId, data?.toolName);
        if (tool) {
          tool.output = data?.content;
          tool.isError = data?.isError;
          tool.status = data?.isError ? "error" : "completed";
        }
        break;
      }

      case "turn_end": {
        const assistant = this.getCurrentAssistantSnapshot(ctx);
        if (assistant) {
          assistant.isStreaming = false;
          assistant.completedAt = Date.now();
        }
        ctx.liveAssistantId = undefined;
        break;
      }

      case "agent_end": {
        const completedAt = Date.now();
        for (const message of ctx.messageSnapshot) {
          if (message?.role === "assistant") {
            message.isStreaming = false;
            message.completedAt ??= completedAt;
          }
        }
        ctx.liveAssistantId = undefined;
        break;
      }
    }

    ctx.messagesVersion++;
    ctx.snapshotVersion = ctx.messagesVersion;
    return true;
  }

  private warmMessageSnapshot(ctx: RuntimeContext, broadcastWhenReady = false): void {
    if (ctx.snapshotInFlight || ctx.disposed) return;
    ctx.snapshotInFlight = true;
    const version = ctx.messagesVersion;

    // Defer heavy serialization away from the latency-critical switch path.
    setTimeout(() => {
      try {
        if (ctx.disposed) return;
        const messages = getSerializedMessageTailForSession(ctx.session, this.snapshotTailMessages);
        if (ctx.messagesVersion === version && !ctx.disposed) {
          ctx.messageSnapshot = messages;
          ctx.messageSnapshotFull = false;
          ctx.snapshotVersion = version;
          if (broadcastWhenReady && this.activeContextKey === ctx.key) {
            this.wsManager.broadcast({
              type: "session_messages",
              data: {
                sessionFile: ctx.session.sessionFile ?? null,
                messages,
              },
            });
          }
        }
      } catch (err: any) {
        console.warn(`[pi-web] Failed to warm message snapshot:`, err?.message ?? err);
      } finally {
        ctx.snapshotInFlight = false;
      }
    }, 0);
  }

  private disposeRuntimeContext(ctx: RuntimeContext, reason: string): void {
    if (ctx.disposed || this.activeContextKey === ctx.key || this.isContextBusy(ctx)) return;
    this.clearCompletionTimer(ctx);
    ctx.disposed = true;
    this.runtimeContexts.delete(ctx.key);
    ctx.unsubscribeEvents?.();
    ctx.unsubscribeEvents = null;
    this.stopExternalSessionFileSync(ctx);
    void Promise.resolve(ctx.runtime?.dispose?.()).catch(() => {
      /* ignore */
    });
    console.log(`[pi-web] Evicted idle prewarm runtime (${reason}): ${ctx.session.sessionFile?.split("/").pop() ?? ctx.key}`);
  }

  private evictIdlePrewarmContexts(): void {
    const now = Date.now();
    const candidates = [...this.runtimeContexts.values()].filter((ctx) =>
      !ctx.disposed &&
      !ctx.everActivated &&
      this.activeContextKey !== ctx.key &&
      !this.isContextBusy(ctx)
    );

    for (const ctx of candidates) {
      if (now - ctx.lastAccessAt > this.idlePrewarmTtlMs) {
        this.disposeRuntimeContext(ctx, "ttl");
      }
    }

    const remaining = [...this.runtimeContexts.values()]
      .filter((ctx) =>
        !ctx.disposed &&
        !ctx.everActivated &&
        this.activeContextKey !== ctx.key &&
        !this.isContextBusy(ctx)
      )
      .sort((a, b) => a.lastAccessAt - b.lastAccessAt);

    while (remaining.length > this.maxIdlePrewarmContexts) {
      const ctx = remaining.shift();
      if (ctx) this.disposeRuntimeContext(ctx, "lru");
    }
  }

  private withSessionEvent(ctx: RuntimeContext, event: WsEventData): WsEventData {
    const base = event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? { ...(event.data as Record<string, unknown>) }
      : { value: event.data };
    return {
      type: event.type,
      data: {
        ...base,
        sessionFile: ctx.session.sessionFile ?? null,
        sessionId: ctx.session.sessionId,
      },
    };
  }

  private setActiveContext(ctx: RuntimeContext, reason = "switched", previousSessionFile?: string | null) {
    const previousKey = this.activeContextKey;
    const previousCtx = previousKey ? this.runtimeContexts.get(previousKey) : undefined;

    ctx.everActivated = true;
    ctx.lastAccessAt = Date.now();

    this.activeContextKey = ctx.key;
    this.runtime = ctx.runtime;
    this.session = ctx.session;
    this.cwd = ctx.cwd;

    this.syncSessionFileFromDisk(ctx, "activate");
    const cachedMessages = this.getSessionSwitchSnapshot(ctx);
    this.wsManager.broadcast({
      type: "session_start",
      data: {
        reason,
        sessionFile: ctx.session.sessionFile ?? null,
        cwd: ctx.cwd,
        previousSessionFile: previousSessionFile ?? null,
        isStreaming: this.isContextBusy(ctx),
        model: ctx.session.model
          ? {
              id: ctx.session.model.id,
              provider: ctx.session.model.provider,
              name: ctx.session.model.name,
              contextWindow: (ctx.session.model as any).contextWindow,
              maxTokens: (ctx.session.model as any).maxTokens,
              reasoning: (ctx.session.model as any).reasoning,
            }
          : null,
        thinkingLevel: ctx.session.thinkingLevel,
        tokenUsage: serializeTokenUsage(ctx.session),
        messages: cachedMessages,
      },
    });

    if (!cachedMessages) {
      this.warmMessageSnapshot(ctx, true);
    }

    // Only two statuses can change on active switch: previous active and new active.
    // Broadcasting every runtime here becomes expensive with many warmed sessions.
    if (previousCtx && previousCtx.key !== ctx.key) {
      this.broadcastSessionStatus(previousCtx);
    }
    this.broadcastSessionStatus(ctx);
  }

  private async bindRuntimeContext(ctx: RuntimeContext): Promise<void> {
    ctx.unsubscribeEvents?.();
    this.stopExternalSessionFileSync(ctx);
    await bindSessionToWebUI(ctx.session, this.uiBridge);

    ctx.unsubscribeEvents = subscribeToSessionEvents(ctx.session, (event: WsEventData) => {
      const mutatesMessages = [
        "agent_start",
        "agent_end",
        "message_start",
        "message_end",
        "text_delta",
        "thinking_delta",
        "turn_start",
        "turn_end",
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
        "tool_result",
      ].includes(event.type);
      if (mutatesMessages) {
        const appliedIncrementally = this.applyEventToMessageSnapshot(ctx, event);
        if (!appliedIncrementally) {
          this.markMessagesDirty(ctx);
        }
      }

      if (event.type === "agent_start") {
        this.clearCompletionTimer(ctx);
        this.persistSessionActivity(ctx, "running");
      }

      // Only stream detailed chat deltas for the currently viewed session.
      // Background sessions keep running, but their deltas won't corrupt the active chat UI.
      // agent_end is held until the session is truly idle; the SDK emits it before retry/finally work settles.
      if (this.activeContextKey === ctx.key && event.type !== "agent_end") {
        try {
          this.wsManager.broadcast(this.withSessionEvent(ctx, event));
        } catch {
          /* swallow */
        }
      }

      if (
        event.type === "agent_start" ||
        event.type === "agent_end" ||
        event.type === "queue_update" ||
        event.type === "session_start" ||
        event.type === "session_shutdown"
      ) {
        this.broadcastSessionStatus(ctx);
      }

      // Send a session-aware push notification only after the session is truly idle.
      if (event.type === "agent_end") {
        this.scheduleCompletionNotification(ctx, event.data);
      }
    });

    // Keep compatibility with SDK operations that replace a runtime internally
    // (fork/import/etc). Our normal web session switching avoids this path.
    this.startExternalSessionFileSync(ctx);

    ctx.runtime.setRebindSession?.(async (newSession: AgentSession) => {
      const oldKey = ctx.key;
      ctx.session = newSession;
      ctx.cwd = ctx.runtime.cwd;
      ctx.key = this.getSessionKey(newSession);

      if (oldKey !== ctx.key) {
        this.runtimeContexts.delete(oldKey);
        this.runtimeContexts.set(ctx.key, ctx);
        if (this.activeContextKey === oldKey) this.activeContextKey = ctx.key;
      }

      await this.bindRuntimeContext(ctx);
      if (this.activeContextKey === ctx.key) {
        this.setActiveContext(ctx, "switched");
      } else {
        this.broadcastSessionStatus(ctx);
      }
    });
  }

  private async registerRuntime(runtime: any): Promise<RuntimeContext> {
    const session = runtime.session as AgentSession;
    const key = this.getSessionKey(session);
    const existing = this.runtimeContexts.get(key);
    if (existing) return existing;

    const persisted = session.sessionFile ? this.persistedSessionActivity.get(session.sessionFile) : undefined;
    const ctx: RuntimeContext = {
      key,
      runtime,
      session,
      cwd: runtime.cwd,
      promptInFlight: false,
      unsubscribeEvents: null,
      messageSnapshot: undefined,
      messageSnapshotFull: false,
      messagesVersion: 0,
      snapshotVersion: -1,
      snapshotInFlight: false,
      liveAssistantId: undefined,
      everActivated: false,
      lastAccessAt: Date.now(),
      disposed: false,
      activityStatus: session.isStreaming ? "running" : (persisted?.status ?? "waiting"),
      externalSyncInFlight: false,
    };
    this.runtimeContexts.set(key, ctx);
    await this.bindRuntimeContext(ctx);
    return ctx;
  }

  async prewarmSession(sessionFile: string): Promise<RuntimeContext> {
    const safeSessionFile = this.resolveSessionFilePath(sessionFile);
    const existing = this.findContextBySessionFile(safeSessionFile);
    if (existing) {
      existing.lastAccessAt = Date.now();
      return existing;
    }

    const inFlight = this.prewarmInFlight.get(safeSessionFile);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const sessionManager = SessionManager.open(safeSessionFile);
      const result = await createRuntime({
        cwd: sessionManager.getCwd(),
        agentDir: this.agentDir || this.opts.agentDir,
        sessionManager,
        sessionStartEvent: { type: "session_start", reason: "prewarm" },
      });
      const ctx = await this.registerRuntime(result.runtime);
      ctx.lastAccessAt = Date.now();
      this.broadcastSessionStatus(ctx);
      this.warmMessageSnapshot(ctx, false);
      this.evictIdlePrewarmContexts();
      return ctx;
    })().finally(() => {
      this.prewarmInFlight.delete(safeSessionFile);
    });

    this.prewarmInFlight.set(safeSessionFile, promise);
    return promise;
  }

  private pumpPrewarmQueue(): void {
    while (this.prewarmActive < this.prewarmConcurrency && this.prewarmQueue.length > 0) {
      const sessionFile = this.prewarmQueue.shift();
      if (!sessionFile || this.findContextBySessionFile(sessionFile) || this.prewarmInFlight.has(sessionFile)) {
        continue;
      }

      this.prewarmActive++;
      void this.prewarmSession(sessionFile)
        .catch((err) => {
          console.warn(`[pi-web] Failed to prewarm session ${sessionFile}:`, err?.message ?? err);
        })
        .finally(() => {
          this.prewarmActive--;
          this.pumpPrewarmQueue();
        });
    }
  }

  prewarmSessions(sessionFiles: string[], options?: { priority?: boolean }): void {
    for (const sessionFile of sessionFiles) {
      let safeSessionFile: string;
      try {
        safeSessionFile = this.resolveSessionFilePath(sessionFile);
      } catch {
        continue;
      }
      if (!safeSessionFile || this.findContextBySessionFile(safeSessionFile) || this.prewarmInFlight.has(safeSessionFile)) {
        continue;
      }

      const existingIndex = this.prewarmQueue.indexOf(safeSessionFile);
      if (existingIndex !== -1) {
        if (options?.priority) {
          this.prewarmQueue.splice(existingIndex, 1);
          this.prewarmQueue.unshift(safeSessionFile);
        }
        continue;
      }

      if (!options?.priority && this.prewarmQueue.length >= this.maxPrewarmQueueLength) {
        continue;
      }

      if (options?.priority) {
        this.prewarmQueue.unshift(safeSessionFile);
        while (this.prewarmQueue.length > this.maxPrewarmQueueLength) this.prewarmQueue.pop();
      } else {
        this.prewarmQueue.push(safeSessionFile);
      }
    }
    this.pumpPrewarmQueue();
  }

  async activateSession(sessionFile: string, reason = "switched") {
    const safeSessionFile = this.resolveSessionFilePath(sessionFile);
    const previousSessionFile = this.session?.sessionFile ?? null;
    const existing = this.findContextBySessionFile(safeSessionFile);
    if (existing) {
      this.setActiveContext(existing, reason, previousSessionFile);
      return { cancelled: false, sessionFile: existing.session.sessionFile ?? null };
    }

    const ctx = await this.prewarmSession(safeSessionFile);
    this.setActiveContext(ctx, reason, previousSessionFile);
    return { cancelled: false, sessionFile: ctx.session.sessionFile ?? null };
  }

  async createNewRuntimeSession(options?: { cwd?: string; sessionManager?: SessionManager; reason?: string }) {
    const previousSessionFile = this.session?.sessionFile ?? null;
    const cwd = options?.cwd ?? this.cwd;
    const sessionDir = this.session?.sessionManager?.getSessionDir?.();
    const sessionManager = options?.sessionManager ?? SessionManager.create(cwd, sessionDir);
    const result = await createRuntime({
      cwd,
      agentDir: this.agentDir || this.opts.agentDir,
      sessionManager,
      sessionStartEvent: { type: "session_start", reason: options?.reason ?? "new", previousSessionFile },
    });
    const ctx = await this.registerRuntime(result.runtime);
    this.setActiveContext(ctx, options?.reason ?? "new", previousSessionFile);
    return { cancelled: false, sessionFile: ctx.session.sessionFile ?? null, sessionId: ctx.session.sessionId, cwd: ctx.cwd };
  }

  async start() {
    this.agentDir = this.opts.agentDir || "";
    this.loadPersistedSessionActivity();
    this.uiBridge = createWebUIBridge((event) => {
      try {
        this.wsManager.broadcast(event);
      } catch {
        /* swallow */
      }
    });

    // Resume most recent session at startup, without creating and leaking an extra empty session.
    let initialCwd = this.opts.cwd;
    let initialSessionManager: SessionManager | undefined;
    try {
      const sessions = await SessionManager.list(this.opts.cwd);
      if (sessions && sessions.length > 0) {
        const sorted = [...sessions].sort((a: any, b: any) => {
          const aTime = a.modified ? new Date(a.modified).getTime() : 0;
          const bTime = b.modified ? new Date(b.modified).getTime() : 0;
          return bTime - aTime;
        });
        const mostRecent = sorted[0];
        if (mostRecent?.path) {
          console.log(`[pi-web] Resuming last session: ${mostRecent.path.split("/").pop()}`);
          initialSessionManager = SessionManager.open(mostRecent.path);
          initialCwd = initialSessionManager.getCwd();
        }
      }
    } catch {
      // If session resume fails, create a fresh session below.
    }

    const result = await createRuntime({
      cwd: initialCwd,
      agentDir: this.opts.agentDir,
      sessionManager: initialSessionManager,
    });

    if (result.runtime.modelFallbackMessage) {
      console.log(`[pi-web] ⚠️  ${result.runtime.modelFallbackMessage}`);
    }
    for (const diag of result.runtime.diagnostics ?? []) {
      console.log(`[pi-web] ⚠️  ${diag.message}`);
    }

    const initialCtx = await this.registerRuntime(result.runtime);
    this.setActiveContext(initialCtx, "initial");

    // Initialize push notification manager
    // Must await so sendToAll doesn't get skipped due to uninitialized flag
    try {
      await this.pushManager.init();
      console.log("[pi-web] Push manager ready");
    } catch (err) {
      console.error("[pi-web] Push manager init failed:", err);
    }

    // Start HTTP+WS server (HTTPS if certs available for push notification support)
    const bindHost = this.opts.host || "127.0.0.1";
    const actualPort = await findAvailablePort(bindHost, this.opts.port, 10);

    const app = createServer(this);

    const serverOptions: any = { fetch: app.fetch, port: actualPort, hostname: bindHost };
    let httpServer;
    let protocol: "http" | "https" = "http";

    const useHttps = this.opts.https;
    if (useHttps) {
      // Look for cert files: first from opts, then ~/.pi/certs/
      const certDir = path.join(process.env.HOME || "/tmp", ".pi", "certs");
      const certPath = this.opts.httpsCert || path.join(certDir, "localhost.pem");
      const keyPath = this.opts.httpsKey || path.join(certDir, "localhost-key.pem");

      if (existsSync(certPath) && existsSync(keyPath)) {
        const httpsOpts = {
          cert: readFileSync(certPath),
          key: readFileSync(keyPath),
        };
        const { serve } = await import("@hono/node-server");
        httpServer = serve({
          ...serverOptions,
          createServer: () => createHttpsServer(httpsOpts),
        });
        protocol = "https";
        console.log(`[pi-web] 🔒 HTTPS enabled (cert: ${certPath})`);
      } else {
        console.warn(`[pi-web] ⚠️  HTTPS requested but cert/key not found at:\n  cert: ${certPath}\n  key:  ${keyPath}\n  Falling back to HTTP. Generate certs with: mkcert localhost`);
        const { serve } = await import("@hono/node-server");
        httpServer = serve(serverOptions);
      }
    } else {
      const { serve } = await import("@hono/node-server");
      httpServer = serve(serverOptions);
    }

    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ server: httpServer as any, path: "/ws" });
    this.wss.on("connection", async (ws, req) => {
      const url = new URL(req.url || "/", "http://localhost");
      // WebSocket auth: use the HttpOnly login cookie. Avoid credentials in query strings,
      // because reverse proxies and logs often persist request URLs.
      const authConfig = getAuthConfig();
      if (authConfig.enabled) {
        const creds = credentialsFromCookie(req.headers.cookie);
        if (!creds || !credentialsValid(creds.username, creds.password)) {
          ws.close(4001, "Authentication required");
          return;
        }
      }

      const desiredSessionFile = url.searchParams.get("session");
      if (desiredSessionFile && desiredSessionFile !== this.session?.sessionFile) {
        try {
          // Align the initial connected snapshot with the client's desired/notification session.
          await this.activateSession(desiredSessionFile, "client_connect");
        } catch (err: any) {
          console.warn(`[pi-web] Failed to activate client requested session:`, err?.message ?? err);
        }
      }

      const client: WsClient = {
        send: (data: string) => {
          try {
            ws.send(data);
          } catch {
            /* closed */
          }
        },
        close: () => {
          try {
            ws.close();
          } catch {
            /* closed */
          }
        },
      };
      const removeClient = this.wsManager.addClient(client);
      try {
        ws.send(
          JSON.stringify({
            type: "connected",
            data: {
              sessionFile: this.session.sessionFile ?? null,
              cwd: this.cwd,
              isStreaming: this.isSessionBusy(this.session),
              model: this.session.model
                ? {
                    id: this.session.model.id,
                    provider: this.session.model.provider,
                    name: this.session.model.name,
                    contextWindow: (this.session.model as any).contextWindow,
                    maxTokens: (this.session.model as any).maxTokens,
                    reasoning: (this.session.model as any).reasoning,
                  }
                : null,
              thinkingLevel: this.session.thinkingLevel,
              tokenUsage: serializeTokenUsage(this.session),
            },
          }),
        );
        this.broadcastAllSessionStatuses();
        this.uiBridge.replayPendingRequests((event) => ws.send(JSON.stringify(event)));
      } catch {
        /* disconnected */
      }

      ws.on("close", () => removeClient());
      ws.on("error", () => removeClient());
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong", id: msg.id }));
        } catch {
          /* ignore */
        }
      });
    });

    this.port = actualPort;
    this.cwd = this.runtime.cwd;
    const displayHost = bindHost === "0.0.0.0" ? "localhost" : bindHost;
    console.log(`[pi-web] Listening on ${protocol}://${displayHost}:${actualPort} (bound to ${bindHost})`);
  }

  async stop() {
    try {
      console.log("[pi-web] Shutting down...");
      this.savePersistedSessionActivity();
      for (const ctx of this.runtimeContexts.values()) {
        ctx.unsubscribeEvents?.();
        this.stopExternalSessionFileSync(ctx);
      }
      this.wsManager.closeAll();
      this.wss?.close();
      this.httpServer?.close();
      await this.pushManager.stop();
      await Promise.allSettled([...this.runtimeContexts.values()].map((ctx) => ctx.runtime?.dispose?.()));
      this.runtimeContexts.clear();
    } catch {
      /* ignore */
    }
  }
}

export async function createApp(opts: AppOptions): Promise<PiWebApp> {
  const app = new PiWebApp(opts);
  return app;
}
