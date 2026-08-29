// Deterministic evaluation of the FX funding-leg playbook (prompt rule 7).
//
// The AI is told, every tick, to: unwind orphaned legs, cut legs worse than
// −1.5%, take profit past +2.0%, and never trade a stale pair. That guidance
// was previously invisible — the UI showed a P&L number with no explanation
// of why a leg was still open. This module encodes the same rules as pure
// functions so that:
//   1. the FX decision log can show exactly which signals fired, and
//   2. the historical backtest scores the identical rule set.
//
// Pure module: no I/O, safe to import from client components and tests.

export const FX_PLAYBOOK = {
  /** Close a losing leg once it is worse than this (fraction of notional). */
  stopLossPct: -0.015,
  /** Take profit once the leg is better than this. */
  takeProfitPct: 0.02,
  /** A rate observation older than this is treated as unusable. */
  staleMinutes: 60,
} as const;

export type FxLegAction = "close_loss" | "close_profit" | "unwind_orphan" | "hold_stale" | "keep";

export type FxPlaybookSignal = {
  id: string;
  label: string;
  /** Human-readable value of the signal at evaluation time. */
  value: string;
  triggered: boolean;
};

export type FxLegPlaybookInput = {
  symbol: string;
  /** Signed units of base currency (negative = short base). */
  quantity: number;
  /** Entry rate (quote per 1 base). */
  avgCost: number;
  /** Current market rate, or null when unavailable. */
  rate: number | null;
  /** Unrealised P&L in the quote currency. */
  pnlQuote: number;
  /** Absolute notional at the current rate, in the quote currency. */
  notionalQuote: number;
  /** Feed marked the rate stale (or it is older than staleMinutes). */
  stale: boolean;
  /** Age of the rate observation in minutes, when known. */
  rateAgeMinutes?: number | null;
  /**
   * True when the leg no longer funds anything — no holding is denominated
   * in the leg's quote currency, so the exposure is unintentional.
   */
  orphaned?: boolean;
};

export type FxLegPlaybookVerdict = {
  symbol: string;
  action: FxLegAction;
  /** Short sentence shown as the headline in the decision log. */
  headline: string;
  /** P&L as a fraction of notional (0.021 = +2.1%). */
  pnlPct: number;
  signals: FxPlaybookSignal[];
};

const ACTION_HEADLINE: Record<FxLegAction, string> = {
  close_loss: "Close — loss past the −1.5% cut line",
  close_profit: "Close — profit past the +2.0% take line",
  unwind_orphan: "Unwind — leg funds nothing",
  hold_stale: "Hold — rate is stale, no trading on a bad mark",
  keep: "Keep — inside the ±band, still funding exposure",
};

function pct(n: number): string {
  return `${n >= 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(2)}%`;
}

export function evaluateFxLegPlaybook(input: FxLegPlaybookInput): FxLegPlaybookVerdict {
  const notional = Math.abs(Number(input.notionalQuote));
  const pnlPct = notional > 0 && Number.isFinite(input.pnlQuote) ? input.pnlQuote / notional : 0;

  const ageMin = input.rateAgeMinutes ?? null;
  const stale =
    Boolean(input.stale) ||
    input.rate == null ||
    !(Number(input.rate) > 0) ||
    (ageMin != null && ageMin > FX_PLAYBOOK.staleMinutes);

  const orphaned = Boolean(input.orphaned);
  const hitStop = !stale && pnlPct <= FX_PLAYBOOK.stopLossPct;
  const hitTarget = !stale && pnlPct >= FX_PLAYBOOK.takeProfitPct;

  // Precedence: a stale mark disqualifies any action; then orphan unwind;
  // then loss cut before profit take (loss control dominates).
  let action: FxLegAction = "keep";
  if (stale) action = "hold_stale";
  else if (orphaned) action = "unwind_orphan";
  else if (hitStop) action = "close_loss";
  else if (hitTarget) action = "close_profit";

  const signals: FxPlaybookSignal[] = [
    {
      id: "rate_freshness",
      label: "Rate freshness",
      value:
        input.rate == null
          ? "no live mark"
          : ageMin != null
            ? `${Math.round(ageMin)} min old${stale ? " (stale)" : ""}`
            : stale
              ? "stale"
              : "fresh",
      triggered: stale,
    },
    {
      id: "direction",
      label: "Direction",
      value: `${input.quantity < 0 ? "short" : "long"} ${input.symbol} @ ${input.avgCost || 0}`,
      triggered: false,
    },
    {
      id: "mark",
      label: "Mark vs entry",
      value:
        input.rate != null && input.avgCost > 0
          ? `${input.rate} vs ${input.avgCost} (${pct(input.rate / input.avgCost - 1)})`
          : "unavailable",
      triggered: false,
    },
    {
      id: "unrealised",
      label: "Unrealised P&L",
      value: `${pct(pnlPct)} of notional`,
      triggered: hitStop || hitTarget,
    },
    {
      id: "stop_line",
      label: `Cut line ${pct(FX_PLAYBOOK.stopLossPct)}`,
      value: hitStop ? "breached" : "not breached",
      triggered: hitStop,
    },
    {
      id: "target_line",
      label: `Take line ${pct(FX_PLAYBOOK.takeProfitPct)}`,
      value: hitTarget ? "reached" : "not reached",
      triggered: hitTarget,
    },
    {
      id: "funding_purpose",
      label: "Funding purpose",
      value: orphaned ? "no holding uses this currency" : "funds live exposure",
      triggered: orphaned,
    },
  ];

  return { symbol: input.symbol, action, headline: ACTION_HEADLINE[action], pnlPct, signals };
}
