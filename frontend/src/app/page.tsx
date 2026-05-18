"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import { createWsConnection, type WsEvent } from "@/lib/api";
import { ChatPanel } from "@/components/ChatPanel";
import { Sidebar } from "@/components/Sidebar";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { LoginPage } from "@/components/LoginPage";
import { FolderOpen, Settings, Menu, Wifi, WifiOff } from "lucide-react";
import { registerServiceWorker, trySetupPushNotifications } from "@/lib/push-notifications";
import { loadCredentials, clearCredentials, checkAuthStatus, validateCredentials, checkAuthenticatedSession, logoutSession } from "@/lib/auth";

const PENDING_SESSION_CACHE = "pi-web-notification-state";
const PENDING_SESSION_KEY = "/__pi-web-pending-session-open";

async function consumePendingNotificationSession(): Promise<string | null> {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(PENDING_SESSION_CACHE);
    const response = await cache.match(PENDING_SESSION_KEY);
    if (!response) return null;

    await cache.delete(PENDING_SESSION_KEY);
    const data = await response.json().catch(() => null);
    const sessionFile = typeof data?.sessionFile === "string" ? data.sessionFile : null;
    const createdAt = typeof data?.createdAt === "number" ? data.createdAt : 0;

    // Ignore very old click intents so a stale cache entry doesn't surprise-switch later.
    if (!sessionFile || Date.now() - createdAt > 10 * 60 * 1000) return null;
    return sessionFile;
  } catch {
    return null;
  }
}

export default function HomePage() {
  const store = useAppStore();
  const wsRef = useRef<ReturnType<typeof createWsConnection> | null>(null);
  const lastSessionOpenRequestRef = useRef<{ sessionFile: string; at: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  // Check stored credentials on mount
  useEffect(() => {
    async function checkAuth() {
      const status = await checkAuthStatus();
      if (!status.enabled) {
        // Auth disabled on server — proceed directly
        setAuthenticated(true);
        return;
      }

      if (await checkAuthenticatedSession()) {
        clearCredentials();
        setAuthenticated(true);
        return;
      }

      const legacyCreds = loadCredentials();
      if (legacyCreds) {
        // One-time migration from older localStorage password storage to the
        // server-issued HttpOnly cookie.
        if (await validateCredentials(legacyCreds)) {
          clearCredentials();
          setAuthenticated(true);
          return;
        }
        clearCredentials();
      }
      setAuthenticated(false);
    }
    checkAuth();
  }, []);

  // Listen for unauthorized events from API calls
  useEffect(() => {
    const handleUnauthorized = () => {
      clearCredentials();
      setAuthenticated(false);
      // Close any existing WS connection
      wsRef.current?.close();
    };
    window.addEventListener("pi-web:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("pi-web:unauthorized", handleUnauthorized);
  }, []);

  const handleLogout = useCallback(async () => {
    await logoutSession();
    wsRef.current?.close();
    wsRef.current = null;
    store.setSettingsOpen(false);
    setAuthenticated(false);
  }, [store]);

  // Initialize WebSocket connection (only after auth)
  useEffect(() => {
    if (authenticated !== true) return;

    const ws = createWsConnection((event: WsEvent) => {
      store.handleWsEvent(event);
    });
    wsRef.current = ws;

    // Reload state when app comes back from background
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Force WS reconnect if not connected
        if (!ws.connected) {
          ws.reconnect();
        }
        // Refresh lightweight state when returning from background.
        // If WS reconnects, the connected event will reload messages; otherwise
        // fetch messages once to catch up on missed background deltas.
        if (ws.connected) {
          store.loadMessages();
        }
        store.loadAgentState();
        store.loadPendingUiRequests();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      ws.close();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [authenticated]);

  const openSessionFromNotification = useCallback(
    (sessionFile: string | null | undefined) => {
      if (authenticated !== true) return;
      const targetSessionFile = sessionFile?.trim();
      if (!targetSessionFile) return;

      // Avoid double-processing the same notification when service-worker postMessage
      // and URL navigation arrive almost simultaneously.
      const now = Date.now();
      const last = lastSessionOpenRequestRef.current;
      if (last?.sessionFile === targetSessionFile && now - last.at < 1000) return;
      lastSessionOpenRequestRef.current = { sessionFile: targetSessionFile, at: now };

      void store.switchSession(targetSessionFile).then(() => {
        // Ensure notification-opened sessions always refresh to latest even if already active.
        void store.loadMessages();
      });

      const currentSessionParam = new URLSearchParams(window.location.search).get("session");
      if (currentSessionParam) {
        window.history.replaceState({}, "", window.location.pathname);
      }
    },
    [authenticated, store],
  );

  const processUrlSessionLink = useCallback(() => {
    const sessionFile = new URLSearchParams(window.location.search).get("session");
    openSessionFromNotification(sessionFile);
  }, [openSessionFromNotification]);

  const processPendingNotificationSession = useCallback(() => {
    void consumePendingNotificationSession().then((sessionFile) => {
      openSessionFromNotification(sessionFile);
    });
  }, [openSessionFromNotification]);

  // Open session from notification deep link: /?session=<sessionFile>
  // Also handle service-worker messages because iOS/PWA focus can preserve the same SPA instance.
  useEffect(() => {
    if (authenticated !== true) return;

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const data = event.data as any;
      if (data?.type !== "pi-web-open-session") return;
      openSessionFromNotification(data.sessionFile);
    };

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "hidden") return;
      processUrlSessionLink();
      processPendingNotificationSession();
    };

    processUrlSessionLink();
    processPendingNotificationSession();
    navigator.serviceWorker?.addEventListener("message", handleServiceWorkerMessage);
    window.addEventListener("focus", handleVisibilityOrFocus);
    window.addEventListener("pageshow", handleVisibilityOrFocus);
    window.addEventListener("popstate", processUrlSessionLink);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    return () => {
      navigator.serviceWorker?.removeEventListener("message", handleServiceWorkerMessage);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      window.removeEventListener("pageshow", handleVisibilityOrFocus);
      window.removeEventListener("popstate", processUrlSessionLink);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, [authenticated, openSessionFromNotification, processUrlSessionLink, processPendingNotificationSession]);

  // Load initial data only after authentication. Otherwise protected API calls
  // return 401 while the login page is still showing, which can trigger browser
  // auth UI on some clients and can clear a just-entered login state.
  useEffect(() => {
    if (authenticated !== true) return;

    store.loadSessions();
    store.listFiles();
  }, [authenticated]);

  // Responsive sidebar
  useEffect(() => {
    // Auto-open sidebar on desktop
    const mql = window.matchMedia("(min-width: 768px)");
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      const desktop = e.matches;
      setIsDesktop(desktop);
      if (desktop) setSidebarOpen(true);
    };
    handleChange(mql);
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  // Register service worker + set up push notifications (best-effort) only
  // after auth, because push setup calls protected /api/push endpoints.
  useEffect(() => {
    if (authenticated !== true) return;

    registerServiceWorker().then((registration) => {
      if (registration) {
        // If notification permission is already granted, do full push setup
        trySetupPushNotifications().then((ok) => {
          if (ok) console.log("[push] Push notifications active");
        });
      }
    });
  }, [authenticated]);

  const closeSidebarOnMobile = useCallback(() => {
    if (!isDesktop) setSidebarOpen(false);
  }, [isDesktop]);

  // Show login page until authenticated
  if (authenticated === null) {
    return (
      <div className="flex items-center justify-center min-h-[100dvh] bg-[var(--color-bg-primary)]">
        <div className="w-6 h-6 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage onLoginSuccess={() => setAuthenticated(true)} />;
  }

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-[var(--color-bg-primary)]">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && !isDesktop && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      {sidebarOpen && (
        <div
          className={
            isDesktop
              ? "w-64 flex-shrink-0 border-r border-[var(--color-border)] flex flex-col"
              : "fixed inset-y-0 left-0 z-50 w-[280px] bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] flex flex-col shadow-2xl"
          }
        >
          <Sidebar onSessionSelect={closeSidebarOnMobile} />
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-3 py-2 md:px-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 rounded-md hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] transition-colors touch-manipulation"
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
            >
              <Menu size={18} className="text-[var(--color-text-secondary)]" />
            </button>
            <span className="text-sm text-[var(--color-text-secondary)] font-mono truncate max-w-[160px] md:max-w-none">
              {store.sessionFile ? store.sessionFile.split("/").pop() : "New Session"}
            </span>
            {store.isStreaming && (
              <span className="flex items-center gap-1 text-xs text-[var(--color-accent)]">
                <span className="animate-pulse">●</span> Streaming
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => store.setFileBrowserOpen(!store.fileBrowserOpen)}
              className={`p-2 rounded-md transition-colors touch-manipulation ${
                store.fileBrowserOpen
                  ? "bg-[var(--color-accent)] text-white"
                  : "hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] text-[var(--color-text-secondary)]"
              }`}
              title="File browser"
              aria-label="Open workspace"
            >
              <FolderOpen size={18} />
            </button>
            <button
              onClick={() => store.setSettingsOpen(!store.settingsOpen)}
              className={`p-2 rounded-md transition-colors touch-manipulation ${
                store.settingsOpen
                  ? "bg-[var(--color-accent)] text-white"
                  : "hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] text-[var(--color-text-secondary)]"
              }`}
              title="Settings"
              aria-label="Open settings"
            >
              <Settings size={18} />
            </button>
            <div className="flex items-center gap-1 ml-1">
              {store.connected ? (
                <Wifi size={14} className="text-[var(--color-green)]" />
              ) : (
                <WifiOff size={14} className="text-[var(--color-red)]" />
              )}
            </div>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Chat */}
          <div className="flex-1 flex flex-col min-w-0">
            <ChatPanel />
          </div>

          {/* File browser — desktop: inline, mobile: overlay */}
          {store.fileBrowserOpen && (
            isDesktop ? (
              <div className="w-80 flex-shrink-0 border-l border-[var(--color-border)] flex flex-col">
                <WorkspacePanel />
              </div>
            ) : (
              <div className="fixed inset-0 z-40 flex flex-col bg-[var(--color-bg-secondary)] md:hidden">
                <WorkspacePanel />
              </div>
            )
          )}
        </div>


      </div>

      {/* Settings panel (overlay) */}
      {store.settingsOpen && <SettingsPanel onLogout={handleLogout} />}
    </div>
  );
}
