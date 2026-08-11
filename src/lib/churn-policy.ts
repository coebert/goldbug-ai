// Single source of truth for "how long must a name rest before we buy again".
//
// Two separate systems held an opinion and neither knew about the other:
//
//   * the trading style (`trading-style.ts`) sets `reentry_min_days` — 2 days
//     in swing mode, longer in position mode — expressing *strategy* intent;
//   * the portfolio cost governor (`cost-governor.ts`) sets `addCooldownDays`
//     — 5 days for a small account — expressing *cost* intent.
//
// Because the governor runs last, its 5 days silently overrode the style's 2
// days with no log line explaining why a swing re-entry never happened. This
// resolver makes the binding rule explicit and auditable: the cost rule is a
// floor that strategy may lengthen but never shorten, and the caller learns
// which side bound.

export type ChurnInputs = {
  /** Strategy-side minimum rest between entries in the same name. */
  styleReentryMinDays?: number | null;
  /** Cost-side minimum rest, from the NAV-scaled governor profile. */
  governorCooldownDays: number;
  /** Optional label for the active trading style, for the audit line. */
  style?: string | null;
};

export type ChurnPolicy = {
  cooldownDays: number;
  boundBy: "cost" | "style" | "equal";
  reason: string;
};

/**
 * Resolve the effective same-name re-entry cooldown.
 *
 * The cost floor wins ties and wins whenever it is longer, because a fixed
 * commission floor does not care how good the signal is. A style that wants a
 * *longer* rest (position trading) is honoured as-is.
 */
export function resolveChurnPolicy(inputs: ChurnInputs): ChurnPolicy {
  const cost = Math.max(0, Number(inputs.governorCooldownDays) || 0);
  const styleRaw = Number(inputs.styleReentryMinDays);
  const style = Number.isFinite(styleRaw) && styleRaw > 0 ? styleRaw : null;
  const label = inputs.style ? ` (${inputs.style})` : "";

  if (style === null) {
    return {
      cooldownDays: cost,
      boundBy: "cost",
      reason: `cost governor cooldown ${cost}d; no style re-entry rule set`,
    };
  }
  if (style > cost) {
    return {
      cooldownDays: style,
      boundBy: "style",
      reason: `style re-entry rule${label} ${style}d is longer than the cost floor ${cost}d`,
    };
  }
  if (style === cost) {
    return {
      cooldownDays: cost,
      boundBy: "equal",
      reason: `style${label} and cost floor agree at ${cost}d`,
    };
  }
  return {
    cooldownDays: cost,
    boundBy: "cost",
    reason:
      `cost floor ${cost}d overrides the shorter style re-entry rule${label} ` +
      `${style}d — fixed commission floors bind before signal freshness does`,
  };
}
