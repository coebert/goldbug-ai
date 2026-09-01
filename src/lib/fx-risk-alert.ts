// FX risk alerting — pure classification shared by the Summary tab banner,
// the FX risk dashboard and tests.
//
// An open funding leg is "at risk" when the stress engine's worst modelled
// loss is large relative to the cash that would have to absorb it, or when
// the leg is already through the playbook's cut-loss band. Both readings are
// money-based, not percentage-of-rate, so the banner speaks in the same units
// as the Summary tiles.

export type FxRiskLevel = "ok" | "warn" | "critical";

export type FxRiskLegInput = {
  symbol: string;
  pair: string;
  /** Signed base-currency units (negative = short base). */
  quantity: number;
  /** Absolute notional in the portfolio's base currency. */
  notionalBase: number;
  /** Close-now P&L in base ccy, net of the exit fee. */
  pnlBaseNet: number;
  /** Deepest modelled adverse scenario for this leg, base ccy (<= 0). */
  worstCaseBase: number;
  worstCaseLabel: string;
  /** True when the live rate could not be refreshed. */
  stale: boolean;
};

export type FxRiskLegAlert = FxRiskLegInput & {
  level: FxRiskLevel;
  /** Worst case as a share of the cash buffer (0.12 = 12% of cash). */
  worstCaseShareOfCash: number;
  /** Close-now P&L as a share of the leg's own notional. */
  pnlShareOfNotional: number;
  headline: string;
  suggestion: string;
  reasons: string[];
};

export type FxRiskAlertReport = {
  level: FxRiskLevel;
  legs: FxRiskLegAlert[];
  /** Legs at warn or critical, worst first. */
  breaches: FxRiskLegAlert[];
  totalWorstCaseBase: number;
  totalCloseNowBase: number;
  summary: string;
};

export type FxRiskThresholds = {
  /** Worst case >= this share of cash → warn. Default 5%. */
  warnShareOfCash?: number;
  /** Worst case >= this share of cash → critical. Default 10%. */
  criticalShareOfCash?: number;
  /** Loss >= this share of notional → warn (playbook cut band). Default 1.5%. */
  warnLossShareOfNotional?: number;
  /** Loss >= this share of notional → critical. Default 3%. */
  criticalLossShareOfNotional?: number;
};

const DEFAULTS: Required<FxRiskThresholds> = {
  warnShareOfCash: 0.05,
  criticalShareOfCash: 0.1,
  warnLossShareOfNotional: 0.015,
  criticalLossShareOfNotional: 0.03,
};

const worst = (a: FxRiskLevel, b: FxRiskLevel): FxRiskLevel =>
  a === "critical" || b === "critical" ? "critical" : a === "warn" || b === "warn" ? "warn" : "ok";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function assessFxRisk(args: {
  legs: FxRiskLegInput[];
  /** Cash available to absorb a shock, in base ccy. */
  cashBase: number;
  thresholds?: FxRiskThresholds;
}): FxRiskAlertReport {
  const t = { ...DEFAULTS, ...(args.thresholds ?? {}) };
  const cash = Number.isFinite(args.cashBase) && args.cashBase > 0 ? args.cashBase : 0;

  const legs: FxRiskLegAlert[] = args.legs.map((l) => {
    const notional = Math.abs(Number(l.notionalBase) || 0);
    const loss = Math.min(0, Number(l.worstCaseBase) || 0);
    const shareOfCash = cash > 0 ? Math.abs(loss) / cash : 0;
    const pnlShare = notional > 0 ? Number(l.pnlBaseNet) / notional : 0;

    const reasons: string[] = [];
    let level: FxRiskLevel = "ok";

    if (cash > 0 && shareOfCash >= t.criticalShareOfCash) {
      level = worst(level, "critical");
      reasons.push(`worst case is ${pct(shareOfCash)} of cash`);
    } else if (cash > 0 && shareOfCash >= t.warnShareOfCash) {
      level = worst(level, "warn");
      reasons.push(`worst case is ${pct(shareOfCash)} of cash`);
    }

    if (pnlShare <= -t.criticalLossShareOfNotional) {
      level = worst(level, "critical");
      reasons.push(`already down ${pct(Math.abs(pnlShare))} of notional net of fees`);
    } else if (pnlShare <= -t.warnLossShareOfNotional) {
      level = worst(level, "warn");
      reasons.push(`already down ${pct(Math.abs(pnlShare))} of notional net of fees`);
    }

    if (l.stale) {
      level = worst(level, "warn");
      reasons.push("live rate is stale, so the mark cannot be trusted");
    }

    const direction = Number(l.quantity) < 0 ? "short" : "long";
    const headline =
      level === "ok"
        ? `${l.pair} ${direction} within limits`
        : `${l.pair} ${direction} — ${reasons[0]}`;
    const suggestion =
      level === "critical"
        ? l.stale
          ? "Refresh the rate, then close this leg — it is sized beyond the loss budget."
          : `Close this leg now at the live rate; the ${l.worstCaseLabel} scenario costs more than the buffer can absorb.`
        : level === "warn"
          ? `Consider closing or halving this leg — ${l.worstCaseLabel} is the binding scenario.`
          : "No action needed.";

    return {
      ...l,
      level,
      worstCaseShareOfCash: shareOfCash,
      pnlShareOfNotional: pnlShare,
      headline,
      suggestion,
      reasons,
    };
  });

  const breaches = legs
    .filter((l) => l.level !== "ok")
    .sort((a, b) => a.worstCaseBase - b.worstCaseBase);
  const level = legs.reduce<FxRiskLevel>((acc, l) => worst(acc, l.level), "ok");
  const totalWorstCaseBase = legs.reduce((s, l) => s + Math.min(0, l.worstCaseBase), 0);
  const totalCloseNowBase = legs.reduce((s, l) => s + l.pnlBaseNet, 0);

  const summary =
    legs.length === 0
      ? "No open FX legs."
      : level === "ok"
        ? `${legs.length} open FX leg${legs.length === 1 ? "" : "s"} inside the risk budget.`
        : `${breaches.length} of ${legs.length} FX leg${legs.length === 1 ? "" : "s"} over the risk budget — ${breaches[0]?.headline ?? ""}.`;

  return { level, legs, breaches, totalWorstCaseBase, totalCloseNowBase, summary };
}
