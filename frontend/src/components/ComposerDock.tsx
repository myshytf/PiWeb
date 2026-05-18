"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { api, type SlashCommandInfo, type UploadAttachment } from "@/lib/api";
import { InteractionDock } from "./InteractionDock";
import { CornerDownLeft, FileText, Image as ImageIcon, Paperclip, Send, Square, X } from "lucide-react";

const DRAFT_PREFIX = "pi_web_draft:";
const EMPTY_SESSION_KEY = "__new_session__";
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

interface LocalAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

function draftKey(sessionFile: string | null | undefined): string {
  return `${DRAFT_PREFIX}${sessionFile || EMPTY_SESSION_KEY}`;
}

function loadDraft(sessionFile: string | null | undefined): string {
  try {
    return localStorage.getItem(draftKey(sessionFile)) || "";
  } catch {
    return "";
  }
}

function saveDraft(sessionFile: string | null | undefined, value: string): void {
  try {
    const key = draftKey(sessionFile);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function toUploadAttachment(attachment: LocalAttachment): Promise<UploadAttachment> {
  const file = attachment.file;
  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    data: await fileToBase64(file),
    kind: file.type.startsWith("image/") ? "image" : "file",
  };
}

function slashCommandNeedsSpace(command: SlashCommandInfo): boolean {
  return Boolean(command.argumentHint) || ["model", "name", "compact", "export", "import"].includes(command.name);
}

function slashSourceLabel(source: SlashCommandInfo["source"]): string {
  if (source === "builtin") return "pi";
  if (source === "prompt") return "prompt";
  if (source === "skill") return "skill";
  return "ext";
}

export function ComposerDock() {
  const store = useAppStore();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [isDesktop, setIsDesktop] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isPreparingUpload, setIsPreparingUpload] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputValueRef = useRef("");
  const previousSessionRef = useRef<string | null | undefined>(undefined);
  const attachmentsRef = useRef<LocalAttachment[]>([]);
  const attachmentsBySessionRef = useRef<Map<string, LocalAttachment[]>>(new Map());
  const sessionFile = store.sessionFile;

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mql.matches);
    const handler = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      inputRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.listCommands(sessionFile).then((data) => {
      if (!cancelled) setSlashCommands(data.commands);
    }).catch(() => {
      if (!cancelled) setSlashCommands([]);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionFile]);

  // Per-session composer draft: switching sessions preserves textarea and selected attachments independently.
  useEffect(() => {
    const previousSession = previousSessionRef.current;
    if (previousSession !== undefined && previousSession !== sessionFile) {
      saveDraft(previousSession, inputValueRef.current);
      attachmentsBySessionRef.current.set(previousSession || EMPTY_SESSION_KEY, attachmentsRef.current);
    }

    if (previousSession !== sessionFile) {
      const nextDraft = loadDraft(sessionFile);
      const nextAttachments = attachmentsBySessionRef.current.get(sessionFile || EMPTY_SESSION_KEY) ?? [];
      inputValueRef.current = nextDraft;
      attachmentsRef.current = nextAttachments;
      setInput(nextDraft);
      setAttachments(nextAttachments);
      setAttachmentError(null);
      previousSessionRef.current = sessionFile;
      requestAnimationFrame(() => {
        const ta = inputRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = nextDraft ? Math.min(ta.scrollHeight, 200) + "px" : "";
      });
    }
  }, [sessionFile]);

  // Reset textarea height when input is cleared (after send)
  useEffect(() => {
    if (!input && inputRef.current) {
      inputRef.current.style.height = "";
    }
  }, [input]);

  const updateAttachments = useCallback((next: LocalAttachment[]) => {
    attachmentsRef.current = next;
    attachmentsBySessionRef.current.set(sessionFile || EMPTY_SESSION_KEY, next);
    setAttachments(next);
  }, [sessionFile]);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFilesSelected = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachmentError(null);

    const existing = attachmentsRef.current;
    const next = [...existing];
    let totalBytes = existing.reduce((sum, item) => sum + item.file.size, 0);

    for (const file of Array.from(files)) {
      if (next.length >= MAX_ATTACHMENTS) {
        setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
        break;
      }
      if (totalBytes + file.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError(`Attachments can be up to ${formatSize(MAX_ATTACHMENT_BYTES)} total.`);
        break;
      }
      totalBytes += file.size;
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      });
    }

    updateAttachments(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [updateAttachments]);

  const removeAttachment = useCallback((id: string) => {
    const item = attachmentsRef.current.find((attachment) => attachment.id === id);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    updateAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id));
  }, [updateAttachments]);

  const clearAttachments = useCallback(() => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    updateAttachments([]);
  }, [updateAttachments]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const currentAttachments = attachmentsRef.current;
    if (!text && currentAttachments.length === 0) return;

    setAttachmentError(null);
    setIsPreparingUpload(true);
    let uploadAttachments: UploadAttachment[] = [];
    try {
      uploadAttachments = await Promise.all(currentAttachments.map(toUploadAttachment));
    } catch {
      setAttachmentError("Failed to read one or more attachments.");
      setIsPreparingUpload(false);
      return;
    }

    inputValueRef.current = "";
    saveDraft(sessionFile, "");
    setInput("");
    clearAttachments();
    try {
      if (text.startsWith("/") && uploadAttachments.length === 0) {
        await store.executeSlashCommand(text);
      } else {
        await store.sendPrompt(text || "Please analyze the attached file(s).", uploadAttachments);
      }
    } finally {
      setIsPreparingUpload(false);
    }
  }, [input, store, sessionFile, clearAttachments]);

  const handleAbort = useCallback(async () => {
    await store.abortStreaming();
  }, [store]);

  const canSend = !isPreparingUpload && (input.trim().length > 0 || attachments.length > 0);
  const hasContexts = store.selectedFileContexts.length > 0;
  const slashMatch = input.match(/^\/(\S*)$/) ?? input.match(/^\/(\S*)\s.*$/);
  const slashQuery = slashMatch?.[1]?.toLowerCase() ?? "";
  const showSlashMenu = input.startsWith("/") && slashCommands.length > 0 && !input.includes("\n");
  const filteredSlashCommands = showSlashMenu
    ? slashCommands
        .filter((command) => command.name.toLowerCase().includes(slashQuery))
        .slice(0, 8)
    : [];

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [slashQuery, sessionFile]);

  const applySlashCommand = useCallback((command: SlashCommandInfo) => {
    const next = `/${command.name}${slashCommandNeedsSpace(command) ? " " : ""}`;
    inputValueRef.current = next;
    setInput(next);
    saveDraft(sessionFile, next);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [sessionFile]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (filteredSlashCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedSlashIndex((index) => (index + 1) % filteredSlashCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedSlashIndex((index) => (index - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && isDesktop && input.trim() === `/${slashQuery}`)) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[Math.min(selectedSlashIndex, filteredSlashCommands.length - 1)]);
          return;
        }
        if (e.key === "Escape") {
          setSelectedSlashIndex(0);
          return;
        }
      }

      // Desktop: Enter sends, Shift+Enter = newline
      // Mobile: Enter = newline, use Send button to send
      if (e.key === "Enter" && !e.shiftKey && isDesktop) {
        e.preventDefault();
        handleSend();
      }
    },
    [applySlashCommand, filteredSlashCommands, handleSend, input, isDesktop, selectedSlashIndex, slashQuery]
  );

  return (
    <div className="border-t border-[var(--color-border)] px-3 py-3 md:px-4 md:py-4 bg-[var(--color-bg-secondary)]">
      <div className="max-w-4xl mx-auto space-y-2">
        <InteractionDock />

        {hasContexts && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Selected file context">
            {store.selectedFileContexts.map((ctx) => (
              <span
                key={ctx.path}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]"
              >
                <FileText size={12} className="flex-shrink-0 text-[var(--color-accent)]" />
                <span className="truncate max-w-[160px]">{ctx.name}</span>
                <button
                  type="button"
                  aria-label={`Remove context ${ctx.name}`}
                  onClick={() => store.removeFileContext(ctx.path)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] transition-colors"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={store.clearFileContexts}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              clear all
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Selected upload attachments">
            {attachments.map((attachment) => {
              const isImage = attachment.file.type.startsWith("image/");
              return (
                <span
                  key={attachment.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]"
                >
                  {attachment.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={attachment.previewUrl} alt="" className="h-4 w-4 rounded object-cover" />
                  ) : isImage ? (
                    <ImageIcon size={12} className="flex-shrink-0 text-[var(--color-accent)]" />
                  ) : (
                    <FileText size={12} className="flex-shrink-0 text-[var(--color-accent)]" />
                  )}
                  <span className="truncate max-w-[160px]">{attachment.file.name}</span>
                  <span className="text-[10px] text-[var(--color-text-muted)]">{formatSize(attachment.file.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove attachment ${attachment.file.name}`}
                    onClick={() => removeAttachment(attachment.id)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] transition-colors"
                  >
                    <X size={11} />
                  </button>
                </span>
              );
            })}
            <button
              type="button"
              onClick={clearAttachments}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              clear uploads
            </button>
          </div>
        )}

        {attachmentError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-500">
            {attachmentError}
          </div>
        )}

        {store.pendingFollowUps.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            <span className="flex-1">
              {store.pendingFollowUps.length} follow-up{store.pendingFollowUps.length > 1 ? "s" : ""} queued — will send when current turn completes
            </span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFilesSelected(e.target.files)}
        />

        <div className="flex items-center gap-2">
          <div className="flex-1 relative min-w-0 group">
            {filteredSlashCommands.length > 0 && (
              <div className="absolute left-0 right-0 bottom-full mb-2 z-20 max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
                <div className="border-b border-[var(--color-border)] px-3 py-2 text-[11px] font-medium text-[var(--color-text-muted)]">
                  Slash commands
                </div>
                {filteredSlashCommands.map((command, index) => (
                  <button
                    key={`${command.source}:${command.name}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applySlashCommand(command);
                    }}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                      index === selectedSlashIndex ? "bg-[var(--color-bg-hover)]" : "hover:bg-[var(--color-bg-hover)]"
                    }`}
                  >
                    <span className="mt-0.5 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]">
                      {slashSourceLabel(command.source)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-[var(--color-text-primary)]">
                        /{command.name}{command.argumentHint ? ` ${command.argumentHint}` : ""}
                      </span>
                      {command.description && (
                        <span className="block truncate text-xs text-[var(--color-text-muted)]">
                          {command.description}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                const value = e.target.value;
                inputValueRef.current = value;
                setInput(value);
                saveDraft(sessionFile, value);
              }}
              onKeyDown={handleKeyDown}
              placeholder={store.isStreaming ? "Type to queue as follow-up…" : hasContexts ? "Ask about the attached file context…" : "Send a message…"}
              rows={1}
              className="block w-full resize-none rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3.5 py-2.5 pr-8 h-11 text-[16px] md:text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] transition-colors focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]/50"
              style={{ maxHeight: "200px" }}
              onInput={(e) => {
                const ta = e.target as HTMLTextAreaElement;
                ta.style.height = "auto";
                ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
              }}
              enterKeyHint={isDesktop ? "send" : "enter"}
            />
            <div className="absolute right-3 bottom-2.5 text-[10px] text-[var(--color-text-muted)] hidden md:group-focus-within:flex items-center gap-1 pointer-events-none">
              <CornerDownLeft size={11} />
              <span>Send</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 self-stretch flex-shrink-0">
            <button
              type="button"
              onClick={handleAttachClick}
              className="flex items-center justify-center size-[44px] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] text-[var(--color-text-secondary)] transition-all touch-manipulation"
              title="Attach files or images"
              aria-label="Attach files or images"
            >
              <Paperclip size={18} />
            </button>

            {store.isStreaming && (
              <button
                type="button"
                onClick={handleAbort}
                className="flex items-center justify-center size-[44px] rounded-xl bg-[var(--color-red)] hover:bg-red-600 active:bg-red-700 text-white transition-all touch-manipulation shadow-sm hover:shadow-md"
                title="Stop streaming"
                aria-label="Stop streaming"
              >
                <Square size={18} />
              </button>
            )}

            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              className="flex items-center justify-center size-[44px] rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] active:bg-[var(--color-accent)] text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed touch-manipulation shadow-sm hover:shadow-md disabled:shadow-none"
              title={isPreparingUpload ? "Preparing attachments…" : store.isStreaming ? "Queue as follow-up" : "Send message"}
              aria-label={isPreparingUpload ? "Preparing attachments" : store.isStreaming ? "Queue follow-up" : "Send message"}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
