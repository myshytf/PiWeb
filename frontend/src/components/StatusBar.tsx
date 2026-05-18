"use client";

import { useAppStore } from "@/stores/app-store";
import { Activity, Cpu, Brain, Zap } from "lucide-react";

function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

export function StatusBar() {
  const store = useAppStore();
  const usage = store.tokenUsage;
  const contextTokens = usage?.context?.tokens ?? null;
  const contextWindow = usage?.context?.contextWindow ?? store.currentModel?.contextWindow ?? null;
  const contextPercent = usage?.context?.percent ?? (
    contextTokens !== null && contextWindow ? (contextTokens / contextWindow) * 100 : null
  );
  const currentOutput = usage?.current?.output ?? null;
  const liveOutput = currentOutput ?? (store.streamingOutputEstimate > 0 ? store.streamingOutputEstimate : null);
  const liveIsEstimated = currentOutput === null && store.streamingOutputEstimate > 0;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 bg-[var(--color-bg-secondary)] text-[11px] text-[var(--color-text-muted)] safe-bottom">
      <div className="flex items-center gap-3 min-w-0">
        {store.currentModel && (
          <span className="flex items-center gap-1.5 truncate max-w-[35vw] md:max-w-none">
            <Cpu size={11} className="shrink-0 text-[var(--color-text-muted)]" />
            <span className="truncate">{store.currentModel.provider}/{store.currentModel.name}</span>
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Brain size={11} className="shrink-0 text-[var(--color-text-muted)]" />
          <span>{store.thinkingLevel}</span>
        </span>
        <span
          className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"
          title={`Context: ${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} (${formatPercent(contextPercent)})`}
        >
          <Activity size={11} className="shrink-0" />
          <span>ctx {formatTokens(contextTokens)}/{formatTokens(contextWindow)}</span>
          <span className="text-[var(--color-text-muted)]">{formatPercent(contextPercent)}</span>
        </span>
        {usage && (
          <span
            className="hidden md:flex items-center gap-1 text-[var(--color-text-muted)]"
            title={`Total tokens: input ${formatTokens(usage.totals.input)}, output ${formatTokens(usage.totals.output)}, cache ${formatTokens(usage.totals.cacheRead + usage.totals.cacheWrite)}`}
          >
            <span>tok {formatTokens(usage.totals.totalTokens)}</span>
            {liveOutput !== null && store.isStreaming && (
              <span className="text-[var(--color-accent)]">turn {liveIsEstimated ? "~" : ""}{formatTokens(liveOutput)}</span>
            )}
          </span>
        )}
      </div>
      {store.pendingFollowUps.length > 0 && (
        <div className="flex items-center gap-1.5 text-[var(--color-yellow)] shrink-0">
          <Zap size={11} className="shrink-0" />
          <span>{store.pendingFollowUps.length} queued</span>
        </div>
      )}
    </div>
  );
}
