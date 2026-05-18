import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface SerializedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface SerializedTokenUsage {
  current: SerializedUsage | null;
  totals: SerializedUsage;
  context: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function serializeUsage(usage: any): SerializedUsage | null {
  if (!usage) return null;

  const input = numberOrZero(usage.input);
  const output = numberOrZero(usage.output);
  const cacheRead = numberOrZero(usage.cacheRead);
  const cacheWrite = numberOrZero(usage.cacheWrite);
  const totalTokens = numberOrZero(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  const cost = typeof usage.cost === "number" ? usage.cost : numberOrZero(usage.cost?.total);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
}

export function serializeTokenUsage(session: AgentSession, currentUsage?: any): SerializedTokenUsage {
  const stats = session.getSessionStats?.();
  const contextUsage = session.getContextUsage?.() ?? stats?.contextUsage ?? null;
  const tokens = stats?.tokens;

  return {
    current: serializeUsage(currentUsage),
    totals: {
      input: numberOrZero(tokens?.input),
      output: numberOrZero(tokens?.output),
      cacheRead: numberOrZero(tokens?.cacheRead),
      cacheWrite: numberOrZero(tokens?.cacheWrite),
      totalTokens: numberOrZero(tokens?.total),
      cost: numberOrZero(stats?.cost),
    },
    context: contextUsage
      ? {
          tokens: typeof contextUsage.tokens === "number" ? contextUsage.tokens : null,
          contextWindow: numberOrZero(contextUsage.contextWindow),
          percent: typeof contextUsage.percent === "number" ? contextUsage.percent : null,
        }
      : null,
  };
}
