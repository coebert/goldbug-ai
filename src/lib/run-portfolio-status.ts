// Per-portfolio run status for the admin UI.
//
// The hourly/manual run returns a flat `results[]` array that only contains
// portfolios the run actually reached. For a SCOPED manual run that isn't
// enough to answer the question "what ticked?" — you also need to see the
// portfolios that were deliberately left alone (not selected), the ones
// dropped as paused, and when each portfolio last ran.
//
// This module is pure so it can be unit tested without a database.

export type RunPortfolioStatusKind =
  | "ticked"
  | "error"
  | "skipped_recent"
  | "skipped_budget"
  | "skipped_closed"
  | "skipped_other"
  | "paused"
  | "not_selected";

export type RunResultRow = {
  id: string;
  mode: string;
  ok: boolean;
  error?: string;
  value?: number;
  skipped?: string;
  name?: string | null;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
};

export type RunPortfolioRef = {
  id: string;
  name?: string | null;
  mode: string;
  live_paused?: boolean | null;
};

export type RunPortfolioStatus = {
  id: string;
  name: string;
  mode: string;
  /** Was this portfolio in scope for this run? */
  selected: boolean;
  status: RunPortfolioStatusKind;
  /** Short human label for the badge. */
  label: string;
  /** Full reason / error text, when there is one. */
  detail: string | null;
  /** Whether this run performed a decision tick for the portfolio. */
  ticked: boolean;
  /** Most recent decision timestamp known after the run (ISO), if any. */
  lastRunAt: string | null;
  /** Last decision timestamp BEFORE this run started (ISO), if any. */
  previousRunAt: string | null;
  /** Wall-clock tick duration in ms, when the portfolio ticked. */
  durationMs: number | null;
  /** Portfolio value reported by a successful tick. */
  value: number | null;
};

const LABELS: Record<RunPortfolioStatusKind, string> = {
  ticked: "Ticked",
  error: "Failed",
  skipped_recent: "Already ticked",
  skipped_budget: "Budget exceeded",
  skipped_closed: "Markets closed",
  skipped_other: "Skipped",
  paused: "Paused",
  not_selected: "Not selected",
};

export function labelForStatus(kind: RunPortfolioStatusKind): string {
  return LABELS[kind];
}

/** Maps a run result row onto a status kind using its skip/error text. */
export function classifyRunResult(r: RunResultRow): RunPortfolioStatusKind {
  if (!r.ok) return "error";
  const skipped = (r.skipped ?? "").toLowerCase();
  if (!skipped) return "ticked";
  if (skipped.includes("budget-exceeded")) return "skipped_budget";
  if (skipped.includes("already ticked")) return "skipped_recent";
  if (skipped.includes("venues closed") || skipped.includes("market")) return "skipped_closed";
  return "skipped_other";
}

/** Ordering for display: what happened first, then what was left alone. */
const ORDER: RunPortfolioStatusKind[] = [
  "error",
  "ticked",
  "skipped_recent",
  "skipped_budget",
  "skipped_closed",
  "skipped_other",
  "paused",
  "not_selected",
];

export function buildPortfolioRunStatuses(input: {
  /** Every eligible portfolio known to the run, selected or not. */
  portfolios: RunPortfolioRef[];
  /** Ids the run was scoped to; empty/undefined = all portfolios. */
  requestedIds?: string[] | null;
  results: RunResultRow[];
  /** portfolio_id -> ISO timestamp of last decision BEFORE the run. */
  previousRunAt?: Record<string, string | null>;
  /** portfolio_id -> ISO timestamp of last decision AFTER the run. */
  lastRunAt?: Record<string, string | null>;
}): RunPortfolioStatus[] {
  const selection = (input.requestedIds ?? []).filter((id) => typeof id === "string" && id);
  const scoped = selection.length > 0;
  const byId = new Map(input.results.map((r) => [r.id, r]));

  const rows: RunPortfolioStatus[] = input.portfolios.map((p) => {
    const selected = !scoped || selection.includes(p.id);
    const r = byId.get(p.id);
    let status: RunPortfolioStatusKind;
    let detail: string | null = null;

    if (r) {
      status = classifyRunResult(r);
      detail = r.error ?? r.skipped ?? null;
    } else if (!selected) {
      status = "not_selected";
      detail = "Outside this run's selection — left untouched";
    } else if (p.mode !== "paper" && p.live_paused) {
      status = "paused";
      detail = "Live trading paused for this portfolio";
    } else {
      status = "skipped_other";
      detail = "Not reached by this run";
    }

    return {
      id: p.id,
      name: p.name?.trim() || p.id.slice(0, 8),
      mode: p.mode,
      selected,
      status,
      label: LABELS[status],
      detail,
      ticked: status === "ticked",
      lastRunAt: input.lastRunAt?.[p.id] ?? input.previousRunAt?.[p.id] ?? null,
      previousRunAt: input.previousRunAt?.[p.id] ?? null,
      durationMs: r?.duration_ms ?? null,
      value: typeof r?.value === "number" ? r.value : null,
    };
  });

  return rows.sort((a, b) => {
    const d = ORDER.indexOf(a.status) - ORDER.indexOf(b.status);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });
}

/** Headline counts for the summary line above the table. */
export function summarizeRunStatuses(rows: RunPortfolioStatus[]) {
  const count = (k: RunPortfolioStatusKind) => rows.filter((r) => r.status === k).length;
  return {
    total: rows.length,
    ticked: count("ticked"),
    failed: count("error"),
    alreadyTicked: count("skipped_recent"),
    skipped:
      count("skipped_recent") + count("skipped_budget") + count("skipped_closed") + count("skipped_other"),
    untouched: count("not_selected"),
    paused: count("paused"),
  };
}

/** "3m ago" / "just now" — compact relative time for the last-run column. */
export function formatRelativeTime(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "never";
  const diff = Math.max(0, nowMs - t);
  if (diff < 45_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
