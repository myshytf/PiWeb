"use client";

import { useAppStore } from "@/stores/app-store";
import { X, Cpu, Brain, Bell, BellOff, LogOut } from "lucide-react";
import { useState, useEffect } from "react";
import {
  getPushPermissionState,
  requestNotificationPermission,
  trySetupPushNotifications,
  unsubscribeFromPush,
  type PushPermissionState,
} from "@/lib/push-notifications";

interface SettingsPanelProps {
  onLogout?: () => Promise<void> | void;
}

export function SettingsPanel({ onLogout }: SettingsPanelProps) {
  const store = useAppStore();
  const [modelDropdown, setModelDropdown] = useState(false);
  const [thinkingDropdown, setThinkingDropdown] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [pushState, setPushState] = useState<PushPermissionState>(() =>
    getPushPermissionState(),
  );

  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];

  // Sync push permission state on mount
  useEffect(() => {
    setPushState(getPushPermissionState());
  }, []);

  const handleEnablePush = async () => {
    const granted = await requestNotificationPermission();
    if (granted) {
      setPushState("granted");
      // Try full setup after permission granted
      await trySetupPushNotifications();
    } else {
      setPushState(getPushPermissionState());
    }
  };

  const handleDisablePush = async () => {
    await unsubscribeFromPush();
    setPushState(getPushPermissionState());
  };

  const handleLogout = async () => {
    if (!onLogout || loggingOut) return;
    setLoggingOut(true);
    try {
      // Stop push notifications for this browser before clearing the auth cookie,
      // so logged-out devices do not keep receiving session details.
      await unsubscribeFromPush().catch(() => undefined);
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => store.setSettingsOpen(false)}>
      <div className="w-full h-full md:w-96 md:h-auto md:max-h-[80vh] md:rounded-xl bg-[var(--color-bg-secondary)] md:border md:border-[var(--color-border)] md:shadow-2xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg-secondary)] z-10">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Settings</h2>
          <button onClick={() => store.setSettingsOpen(false)} className="p-2 rounded hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)] touch-manipulation">
            <X size={18} className="text-[var(--color-text-muted)]" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Model selector */}
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              <Cpu size={12} className="inline mr-1" /> Model
            </label>
            <div className="relative">
              <button
                onClick={() => { setModelDropdown(!modelDropdown); setThinkingDropdown(false); }}
                className="w-full px-3 py-2 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-left text-[var(--color-text-primary)] hover:border-[var(--color-accent)] transition-colors"
              >
                {store.currentModel
                  ? `${store.currentModel.provider}/${store.currentModel.name}`
                  : "Select model..."}
              </button>
              {modelDropdown && (
                <div className="absolute z-10 w-full mt-1 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {store.availableModels.map((model) => (
                    <button
                      key={`${model.provider}/${model.id}`}
                      onClick={() => {
                        store.setModel(model.provider, model.id);
                        setModelDropdown(false);
                      }}
                      className={`w-full px-3 py-2 text-left text-xs hover:bg-[var(--color-bg-hover)] transition-colors ${
                        store.currentModel?.id === model.id && store.currentModel?.provider === model.provider
                          ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]"
                          : "text-[var(--color-text-primary)]"
                      }`}
                    >
                      <div className="font-medium">{model.name}</div>
                      <div className="text-[var(--color-text-muted)]">{model.provider}/{model.id}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Thinking level */}
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              <Brain size={12} className="inline mr-1" /> Thinking Level
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {thinkingLevels.map((level) => (
                <button
                  key={level}
                  onClick={() => store.setThinkingLevel(level)}
                  className={`px-2 py-1.5 text-xs rounded-md transition-colors ${
                    store.thinkingLevel === level
                      ? "bg-[var(--color-accent)] text-white"
                      : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>

          {/* Push Notifications */}
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              <Bell size={12} className="inline mr-1" /> Push Notifications
            </label>
            {pushState === "unsupported" ? (
              <div className="text-xs text-[var(--color-text-muted)]">
                Not supported by this browser
              </div>
            ) : pushState === "granted" ? (
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-green)] flex items-center gap-1">
                  <Bell size={10} /> Enabled
                </span>
                <button
                  onClick={handleDisablePush}
                  className="text-xs px-2 py-1 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
                >
                  <BellOff size={10} className="inline mr-1" /> Turn off
                </button>
              </div>
            ) : pushState === "denied" ? (
              <div className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                Blocked. Enable in <strong>iOS Settings</strong> →{" "}
                <strong>[pi-web-remote]</strong> → <strong>Notifications</strong>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-text-muted)]">Off</span>
                <button
                  onClick={handleEnablePush}
                  className="text-xs px-3 py-1.5 rounded bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
                >
                  <Bell size={10} className="inline mr-1" /> Enable
                </button>
              </div>
            )}
          </div>

          {/* Connection info */}
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">Connection</label>
            <div className="text-xs text-[var(--color-text-muted)] space-y-1">
              <div>Session: {store.sessionFile || "N/A"}</div>
              <div>Connected: {store.connected ? "Yes" : "No"}</div>
              <div>Messages: {store.messages.length}</div>
            </div>
          </div>

          {/* Account */}
          {onLogout && (
            <div className="pt-3 border-t border-[var(--color-border)]">
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-2">Account</label>
              <button
                type="button"
                onClick={handleLogout}
                disabled={loggingOut}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-500 hover:bg-red-500/15 active:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <LogOut size={14} />
                {loggingOut ? "Logging out…" : "Log out"}
              </button>
              <p className="mt-2 text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                Clears this browser&apos;s secure session cookie and disables push notifications on this device.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}