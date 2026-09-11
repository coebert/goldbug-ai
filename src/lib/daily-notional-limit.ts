// How much BUY notional a single account may route in one UK trading day.
//
// The operator sets ONE figure (`trading_controls.daily_notional_limit`) and it
// is sized for the real-money book. Applying that same absolute figure to a
// practice book worth 100x more is nonsense: the sim account was skipping
// £40k–£120k buys against a £10k ceiling every session, so the practice run no
// longer tested anything the live run would do.
//
// Rule: real money uses the operator's figure verbatim — that is the whole
// point of the limit. A simulated book scales the ceiling to its own NAV, with
// the operator's figure as the floor, so it can behave like a real account of
// its size while still never routing to a live venue.
//
// Pure: the caller supplies the mode, the configured limit and the account NAV.

/** Share of a simulated book's NAV that may be bought in one day. */
export const SIM_DAILY_LIMIT_PCT_OF_NAV = 0.25;

export type DailyLimitInput = {
  /** Operator-configured ceiling, base currency. */
  configuredLimit: number;
  /** Portfolio mode; only `live_prod` routes real money. */
  mode: string | null | undefined;
  /** This portfolio's NAV in its base currency (0 when unknown). */
  navBase?: number | null;
};

export type DailyLimitResult = {
  limit: number;
  /** True when the limit was scaled up for a simulated book. */
  scaled: boolean;
  note: string | null;
};

export function resolveDailyNotionalLimit(input: DailyLimitInput): DailyLimitResult {
  const configured = Math.max(0, Number(input.configuredLimit) || 0);
  const isReal = String(input.mode ?? "").toLowerCase() === "live_prod";
  if (isReal) return { limit: configured, scaled: false, note: null };

  const nav = Number(input.navBase);
  if (!Number.isFinite(nav) || nav <= 0) {
    return { limit: configured, scaled: false, note: null };
  }
  const navScaled = nav * SIM_DAILY_LIMIT_PCT_OF_NAV;
  if (!(navScaled > configured)) return { limit: configured, scaled: false, note: null };
  return {
    limit: navScaled,
    scaled: true,
    note:
      `practice account: daily buy ceiling scaled to ${(SIM_DAILY_LIMIT_PCT_OF_NAV * 100).toFixed(0)}% ` +
      `of its own ${nav.toFixed(0)} NAV (${navScaled.toFixed(0)}) instead of the ` +
      `real-money figure ${configured.toFixed(0)}`,
  };
}
