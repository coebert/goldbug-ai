// Per-run metrics collector for hourly/manual runs.
// Uses AsyncLocalStorage so nested server code (e.g. Saxo adapter) can bump
// counters without threading a context object through every call.

import { AsyncLocalStorage } from "node:async_hooks";

export type RunMetrics = {
  started_at_ms: number;
  saxo_calls_total: number;
  saxo_calls_ok: number;
  saxo_calls_error: number;
  saxo_retries_429: number;
  budget_exceeded_count: number;
  portfolios_ok: number;
  portfolios_error: number;
};

function empty(): RunMetrics {
  return {
    started_at_ms: Date.now(),
    saxo_calls_total: 0,
    saxo_calls_ok: 0,
    saxo_calls_error: 0,
    saxo_retries_429: 0,
    budget_exceeded_count: 0,
    portfolios_ok: 0,
    portfolios_error: 0,
  };
}

const storage = new AsyncLocalStorage<RunMetrics>();

export function withRunMetrics<T>(fn: (m: RunMetrics) => Promise<T>): Promise<T> {
  const m = empty();
  return storage.run(m, () => fn(m));
}

export function current(): RunMetrics | undefined {
  return storage.getStore();
}

export function bumpSaxo(kind: "ok" | "error", retries429 = 0) {
  const m = storage.getStore();
  if (!m) return;
  m.saxo_calls_total += 1;
  if (kind === "ok") m.saxo_calls_ok += 1;
  else m.saxo_calls_error += 1;
  m.saxo_retries_429 += retries429;
}

export function bumpBudgetExceeded() {
  const m = storage.getStore();
  if (m) m.budget_exceeded_count += 1;
}

export function bumpPortfolio(kind: "ok" | "error") {
  const m = storage.getStore();
  if (!m) return;
  if (kind === "ok") m.portfolios_ok += 1;
  else m.portfolios_error += 1;
}

export function snapshot(m: RunMetrics) {
  return {
    duration_ms: Date.now() - m.started_at_ms,
    saxo_calls_total: m.saxo_calls_total,
    saxo_calls_ok: m.saxo_calls_ok,
    saxo_calls_error: m.saxo_calls_error,
    saxo_retries_429: m.saxo_retries_429,
    budget_exceeded_count: m.budget_exceeded_count,
    portfolios_ok: m.portfolios_ok,
    portfolios_error: m.portfolios_error,
  };
}
