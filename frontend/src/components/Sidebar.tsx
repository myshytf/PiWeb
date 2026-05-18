"use client";

import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api";
import {
  MessageSquare,
  Plus,
  Search,
  X,
  FolderOpen,
  Radio,
  Clock,
  List,
  Circle,
  Loader2,
} from "lucide-react";
import { useState, useMemo } from "react";
import { CwdAutocomplete } from "./CwdAutocomplete";
import { RecentDirs } from "./RecentDirs";

type TabId = "active" | "waiting" | "all";

const prewarmRequested = new Set<string>();

function prewarmSession(sessionFile: string) {
  if (!sessionFile || prewarmRequested.has(sessionFile)) return;
  prewarmRequested.add(sessionFile);
  void api.prewarmSessions([sessionFile], true).catch(() => {
    prewarmRequested.delete(sessionFile);
  });
}

interface SidebarProps {
  onSessionSelect?: () => void;
}

export function Sidebar({ onSessionSelect }: SidebarProps) {
  const store = useAppStore();
  const [activeTab, setActiveTab] = useState<TabId>("all");
  const [search, setSearch] = useState("");
  const [showCwdInput, setShowCwdInput] = useState(false);
  const [cwdInput, setCwdInput] = useState("");
  const [filterCwd, setFilterCwd] = useState<string | null>(null);

  const isActiveSession = (session: typeof store.sessions[number]) =>
    session.isActive === true ||
    session.isStreaming === true ||
    session.status === "running" ||
    session.status === "idle";

  const tabs: { id: TabId; label: string; icon: typeof Radio; count?: number }[] = [
    {
      id: "active",
      label: "Active",
      icon: Radio,
      count: store.sessions.filter(isActiveSession).length,
    },
    {
      id: "waiting",
      label: "Waiting",
      icon: Clock,
      count: store.sessions.filter((s) => !isActiveSession(s)).length,
    },
    {
      id: "all",
      label: "All",
      icon: List,
      count: store.sessions.length,
    },
  ];

  const filteredSessions = useMemo(() => {
    let sessions = store.sessions;

    // Apply tab filter
    if (activeTab === "active") {
      sessions = sessions.filter(isActiveSession);
    } else if (activeTab === "waiting") {
      sessions = sessions.filter((s) => !isActiveSession(s));
    }

    // Apply search
    if (search) {
      const q = search.toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.title?.toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q) ||
          s.file.toLowerCase().includes(q) ||
          (s.firstMessage && s.firstMessage.toLowerCase().includes(q)),
      );
    }

    // Apply cwd filter
    if (filterCwd) {
      sessions = sessions.filter((s) => s.cwd === filterCwd);
    }

    return sessions;
  }, [store.sessions, activeTab, search, filterCwd]);

  const handleNewSession = async () => {
    await store.createNewSession();
    onSessionSelect?.();
  };

  const handleSwitchSession = (sessionFile: string) => {
    // Close mobile sidebar immediately; don't wait for network/runtime work.
    onSessionSelect?.();
    void store.switchSession(sessionFile);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[var(--color-border)] shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Sessions
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={handleNewSession}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] transition-colors touch-manipulation"
              title="New session"
            >
              <Plus size={16} className="text-[var(--color-text-secondary)]" />
            </button>
            <button
              onClick={() => setShowCwdInput(!showCwdInput)}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)] transition-colors touch-manipulation"
              title="New session from folder"
            >
              <FolderOpen
                size={16}
                className="text-[var(--color-text-secondary)]"
              />
            </button>
          </div>
        </div>

        {/* CWD input */}
        {showCwdInput && (
          <div className="flex items-center gap-1 mb-2">
            <CwdAutocomplete
              value={cwdInput}
              onChange={setCwdInput}
              onSubmit={(path) => {
                if (path.trim()) {
                  store.createNewSessionWithCwd(path.trim());
                  setCwdInput("");
                  setShowCwdInput(false);
                  onSessionSelect?.();
                }
              }}
              onClose={() => {
                setCwdInput("");
                setShowCwdInput(false);
              }}
            />
            <button
              onClick={() => {
                if (cwdInput.trim()) {
                  store.createNewSessionWithCwd(cwdInput.trim());
                  setCwdInput("");
                  setShowCwdInput(false);
                  onSessionSelect?.();
                }
              }}
              className="p-1 rounded bg-[var(--color-accent)] text-white text-xs shrink-0"
              title="Create"
            >
              <Plus size={12} />
            </button>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex rounded-lg bg-[var(--color-bg-tertiary)] p-0.5 mb-2">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-medium rounded-md transition-all ${
                  isActive
                    ? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                <Icon size={12} />
                <span>{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span
                    className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[9px] font-semibold ${
                      isActive
                        ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]"
                        : "bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Directories + Search */}
        <RecentDirs selectedCwd={filterCwd} onSelect={setFilterCwd} />
        <div className="relative mt-2">
          <Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions..."
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-md text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--color-bg-hover)]"
            >
              <X size={12} className="text-[var(--color-text-muted)]" />
            </button>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {store.sessions.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <MessageSquare
              size={24}
              className="text-[var(--color-text-muted)] mx-auto mb-2 opacity-40"
            />
            <p className="text-xs text-[var(--color-text-muted)]">
              No sessions yet
            </p>
            <button
              onClick={handleNewSession}
              className="mt-3 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
            >
              Create first session
            </button>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
            {search
              ? "No matching sessions"
              : filterCwd
                ? "No sessions in this directory"
                : activeTab === "active"
                  ? "No active sessions"
                  : activeTab === "waiting"
                    ? "No waiting sessions"
                    : "No sessions"}
          </div>
        ) : (
          filteredSessions.map((session) => {
            const isCurrent = store.sessionFile === session.file;
            const isStreaming = session.isStreaming === true || session.status === "running";
            const isIdle = session.status === "idle";

            return (
              <div
                key={session.sessionId}
                className={`group px-3 py-2.5 cursor-pointer border-b border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] transition-colors touch-manipulation ${
                  isCurrent ? "bg-[var(--color-accent)]/5" : ""
                }`}
                onMouseEnter={() => prewarmSession(session.file)}
                onTouchStart={() => prewarmSession(session.file)}
                onClick={() => handleSwitchSession(session.file)}
              >
                <div className="flex items-start gap-2">
                  {/* Status indicator */}
                  <div className="mt-0.5 flex-shrink-0">
                    {isStreaming ? (
                      <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent)] opacity-75" />
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-[var(--color-accent)]" />
                      </span>
                    ) : isIdle ? (
                      <Clock
                        size={10}
                        className="text-amber-500"
                      />
                    ) : isCurrent ? (
                      <Circle
                        size={10}
                        className="text-[var(--color-green)] fill-[var(--color-green)]"
                      />
                    ) : (
                      <MessageSquare
                        size={10}
                        className="text-[var(--color-text-muted)]"
                      />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-[var(--color-text-primary)] truncate">
                        {session.title ||
                          session.firstMessage ||
                          session.sessionId.slice(0, 12) + "..."}
                      </span>
                      {isCurrent && (
                        <span className="shrink-0 inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
                          Current
                        </span>
                      )}
                      {isStreaming && (
                        <span className="shrink-0 inline-flex items-center gap-1 px-1 py-0.5 rounded text-[9px] font-semibold bg-green-500/20 text-green-500">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          Running
                        </span>
                      )}
                      {isIdle && !isStreaming && (
                        <span className="shrink-0 inline-flex items-center gap-1 px-1 py-0.5 rounded text-[9px] font-semibold bg-amber-500/20 text-amber-500">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                          Idle
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                      {new Date(session.updatedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      · {session.cwd?.split("/").pop()}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Current session info footer */}
      <div className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] shrink-0">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-[var(--color-text-muted)] truncate">
              {store.cwd ? `CWD: ${store.cwd}` : "No cwd"}
            </div>
            <div className="text-[10px] text-[var(--color-text-muted)] truncate mt-0.5">
              {store.sessionFile
                ? `Session: ${store.sessionFile.split("/").pop()}`
                : "No active session"}
            </div>
          </div>
          {store.isStreaming && (
            <Loader2
              size={12}
              className="animate-spin text-[var(--color-accent)] shrink-0"
            />
          )}
        </div>
      </div>
    </div>
  );
}
