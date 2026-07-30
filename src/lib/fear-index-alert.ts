// Pure threshold logic for fear-index alerts. Kept free of Supabase/env so it
// can be unit-tested and reused by the UI to explain when an alert fires.

export const FEAR_ALERT_THRESHOLDS = {
  /** Score at/above which fresh buys are blocked outright (panic). */
  panic: 90,
  /** Score at/above which buy sizing is trimmed (elevated fear). */
  elevated: 60,
  /** Score at/below which sizing is trimmed for complacency. */
  complacency: 15,
} as const;

export type FearAlertLevel = "panic" | "elevated" | "complacency";

export type FearAlertInput = {
  score: number;
  label: string;
  sizeMultiplier: number;
  blockNewBuys: boolean;
  reason?: string | null;
  /** Orders from the run, used to describe the concrete impact. */
  orders: Array<{
    symbol: string;
    side: string;
    value: number;
    rejected?: string | null;
    reason?: string | null;
  }>;
  /** Previous run's score, so we only alert on meaningful moves. */
  previousScore?: number | null;
  thresholds?: Partial<Record<keyof typeof FEAR_ALERT_THRESHOLDS, number>>;
};

export type FearAlertResult = {
  fire: boolean;
  level: FearAlertLevel | null;
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
  blockedSymbols: string[];
  resizedSymbols: string[];
  crossedUp: boolean;
};

const NO_ALERT: FearAlertResult = {
  fire: false,
  level: null,
  severity: "info",
  title: "",
  body: "",
  blockedSymbols: [],
  resizedSymbols: [],
  crossedUp: false,
};

/** Decides whether the current fear reading warrants an operator alert. */
export function evaluateFearAlert(input: FearAlertInput): FearAlertResult {
  const t = { ...FEAR_ALERT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const score = Number.isFinite(input.score) ? input.score : 0;

  const blockedSymbols = input.orders
    .filter((o) => o.side === "buy" && typeof o.rejected === "string" && /fear index/i.test(o.rejected))
    .map((o) => o.symbol);
  const resizedSymbols = input.orders
    .filter((o) => o.side === "buy" && !o.rejected && /fear\d+×/i.test(o.reason ?? ""))
    .map((o) => o.symbol);

  let level: FearAlertLevel | null = null;
  if (score >= t.panic || input.blockNewBuys) level = "panic";
  else if (score >= t.elevated) level = "elevated";
  else if (score <= t.complacency) level = "complacency";

  if (!level) return NO_ALERT;

  // Only alert when the reading crossed a threshold this run, or when sizing
  // actually changed something — otherwise a long fearful stretch would spam.
  const prev = typeof input.previousScore === "number" ? input.previousScore : null;
  const crossedUp =
    prev === null ||
    (level === "panic" && prev < t.panic) ||
    (level === "elevated" && (prev < t.elevated || prev >= t.panic)) ||
    (level === "complacency" && prev > t.complacency);
  const changedSizing = blockedSymbols.length > 0 || resizedSymbols.length > 0;
  if (!crossedUp && !changedSizing) return NO_ALERT;

  const pct = (m: number) => `${Math.round((1 - m) * 100)}%`;
  let title: string;
  let body: string;
  if (level === "panic") {
    title = `Fear index ${score.toFixed(0)}/100 — new buys blocked`;
    body =
      `Market fear hit panic territory (threshold ${t.panic}). Fresh buys are blocked for this run` +
      (blockedSymbols.length ? `: ${blockedSymbols.join(", ")}.` : ".") +
      (input.reason ? ` ${input.reason}` : "");
  } else if (level === "elevated") {
    title = `Fear index ${score.toFixed(0)}/100 — buy sizing trimmed ${pct(input.sizeMultiplier)}`;
    body =
      `Fear is elevated (threshold ${t.elevated}); new buys were sized at ×${input.sizeMultiplier.toFixed(2)}` +
      (resizedSymbols.length ? ` across ${resizedSymbols.join(", ")}.` : ".") +
      (input.reason ? ` ${input.reason}` : "");
  } else {
    title = `Fear index ${score.toFixed(0)}/100 — complacency, sizing trimmed`;
    body =
      `Fear is unusually low (threshold ${t.complacency}), which historically precedes sharp reversals; ` +
      `new buys were sized at ×${input.sizeMultiplier.toFixed(2)}` +
      (resizedSymbols.length ? ` across ${resizedSymbols.join(", ")}.` : ".") +
      (input.reason ? ` ${input.reason}` : "");
  }

  return {
    fire: true,
    level,
    severity: level === "panic" ? "critical" : level === "elevated" ? "warning" : "info",
    title,
    body,
    blockedSymbols,
    resizedSymbols,
    crossedUp,
  };
}
