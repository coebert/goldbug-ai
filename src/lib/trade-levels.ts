// Pure derivation of the exact price levels behind one AI decision:
// the trigger/reference price it acted on, the marketable-limit price it was
// willing to pay (or accept), the protective stop, the profit target and the
// ATR trailing level — plus the risk:reward those imply.
//
// Everything here is deterministic from the persisted decision row + the
// portfolio's risk config, so the panel can show the same numbers the engine
// used without re-running anything.

import { planMarketableLimit } from "./marketable-limit";

export type TradeLevelRiskConfig = {
  stop_loss_pct?: number | null;
  take_profit_pct?: number | null;
  take_profit_enabled?: boolean | null;
  atr_trailing_mult?: number | null;
  atr_scaled_stop_enabled?: boolean | null;
  initial_stop_atr_mult?: number | null;
  atr_scaled_stop_floor_pct?: number | null;
  atr_take_profit_enabled?: boolean | null;
  take_profit_atr_mult?: number | null;
  atr_take_profit_floor_pct?: number | null;
  atr_take_profit_cap_pct?: number | null;
  max_hold_days?: number | null;
};

export type TradeLevelKey = "trigger" | "limit" | "stop" | "target" | "trailing" | "cost_basis";

export type TradeLevel = {
  key: TradeLevelKey;
  label: string;
  /** Price in the instrument's own quote units. */
  price: number;
  /** Signed distance from the reference price as a fraction (0.05 = +5%). */
  distancePct: number | null;
  /** Plain-language formula the engine used to get here. */
  basis: string;
};

export type TradeLevelPlan = {
  side: "buy" | "sell" | "hold";
  referencePrice: number;
  /** Where the reference price came from. */
  referenceSource: string;
  currency: string | null;
  atrPct: number | null;
  atrSource: "measured" | "assumed";
  levels: TradeLevel[];
  /** Downside to the stop, as a positive fraction. */
  riskPct: number | null;
  /** Upside to the target, as a positive fraction. */
  rewardPct: number | null;
  /** reward / risk, when both are known. */
  riskReward: number | null;
  maxHoldDays: number | null;
  notes: string[];
};

const FALLBACK_ATR_PCT = 0.02;

function n(v: unknown): number | null {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function pctText(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The stop distance the engine would apply to a fresh entry. */
export function stopDistancePct(
  cfg: TradeLevelRiskConfig,
  atrPct: number,
): { pct: number; basis: string } {
  const hard = n(cfg.stop_loss_pct) ?? 0.1;
  if (cfg.atr_scaled_stop_enabled && atrPct > 0) {
    const mult = n(cfg.initial_stop_atr_mult) ?? 2;
    const floor = n(cfg.atr_scaled_stop_floor_pct) ?? 0.02;
    const scaled = Math.max(floor, atrPct * mult);
    const pct = Math.min(hard, scaled);
    return {
      pct,
      basis:
        `min(hard stop ${pctText(hard)}, max(floor ${pctText(floor)}, ` +
        `ATR ${pctText(atrPct)} × ${mult}))`,
    };
  }
  return { pct: hard, basis: `flat hard stop ${pctText(hard)} (ATR scaling off)` };
}

/** The profit target distance, or null when the take-profit leg is disabled. */
export function targetDistancePct(
  cfg: TradeLevelRiskConfig,
  atrPct: number,
): { pct: number; basis: string } | null {
  if (cfg.take_profit_enabled === false) return null;
  if (cfg.atr_take_profit_enabled && atrPct > 0) {
    const mult = n(cfg.take_profit_atr_mult) ?? 4;
    const floor = n(cfg.atr_take_profit_floor_pct) ?? 0.06;
    const cap = n(cfg.atr_take_profit_cap_pct) ?? 0.4;
    const pct = clamp(atrPct * mult, floor, cap);
    return {
      pct,
      basis:
        `clamp(ATR ${pctText(atrPct)} × ${mult}, floor ${pctText(floor)}, cap ${pctText(cap)})`,
    };
  }
  const flat = n(cfg.take_profit_pct);
  if (flat == null || flat <= 0) return null;
  return { pct: flat, basis: `flat take-profit ${pctText(flat)}` };
}

export type TradeLevelInput = {
  action: "buy" | "sell" | "hold" | null;
  /** Executed / quoted price for this decision, in quote units. */
  decisionPrice?: number | null;
  /** Last close from the feature snapshot, used when no trade price exists. */
  featurePrice?: number | null;
  /** 14d ATR as a fraction of price. */
  atrPct?: number | null;
  /** Average cost of the existing position, when held. */
  avgCost?: number | null;
  currency?: string | null;
  assetClass?: string | null;
  notional?: number | null;
  tickSize?: number | null;
  config?: TradeLevelRiskConfig | null;
};

export function buildTradeLevels(input: TradeLevelInput): TradeLevelPlan | null {
  const action = input.action ?? "hold";
  const decisionPrice = n(input.decisionPrice);
  const featurePrice = n(input.featurePrice);
  const avgCost = n(input.avgCost);

  const reference =
    decisionPrice && decisionPrice > 0
      ? { price: decisionPrice, source: action === "hold" ? "last recorded price" : "executed trade price" }
      : featurePrice && featurePrice > 0
        ? { price: featurePrice, source: "close from the run's feature snapshot" }
        : avgCost && avgCost > 0
          ? { price: avgCost, source: "position average cost" }
          : null;
  if (!reference) return null;

  const rawAtr = n(input.atrPct);
  const atrKnown = rawAtr != null && rawAtr > 0;
  const atrPct = atrKnown ? (rawAtr as number) : FALLBACK_ATR_PCT;
  const cfg = input.config ?? {};
  const notes: string[] = [];
  if (!atrKnown) {
    notes.push(
      `No ATR was recorded for this run, so the levels assume the ${pctText(FALLBACK_ATR_PCT)} default volatility.`,
    );
  }

  const side: "buy" | "sell" | "hold" = action === "buy" ? "buy" : action === "sell" ? "sell" : "hold";
  const levels: TradeLevel[] = [];

  levels.push({
    key: "trigger",
    label:
      side === "buy" ? "Buy trigger price" : side === "sell" ? "Sell trigger price" : "Reference price",
    price: reference.price,
    distancePct: 0,
    basis: `Level the decision was taken against — ${reference.source}.`,
  });

  if (side !== "hold") {
    const limit = planMarketableLimit({
      side,
      referencePrice: reference.price,
      ...(input.atrPct != null ? { atrPct: input.atrPct } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.assetClass ? { assetClass: input.assetClass } : {}),
      ...(input.notional != null ? { notional: input.notional } : {}),
      ...(input.tickSize != null ? { tickSize: input.tickSize } : {}),
    } as Parameters<typeof planMarketableLimit>[0]);
    if (limit) {
      levels.push({
        key: "limit",
        label: side === "buy" ? "Worst price paid (limit)" : "Worst price accepted (limit)",
        price: limit.limitPrice,
        distancePct: limit.limitPrice / reference.price - 1,
        basis:
          `Marketable limit ${limit.slackBps.toFixed(1)}bps ${side === "buy" ? "above" : "below"} the trigger ` +
          `(modelled half-spread ${limit.halfSpreadBps.toFixed(1)}bps).`,
      });
    }
  }

  const stop = stopDistancePct(cfg, atrPct);
  const target = targetDistancePct(cfg, atrPct);

  // Stops and targets protect a long position, so they hang off the entry
  // (average cost when we already hold, otherwise this trade's price).
  const anchor = side === "sell" ? (avgCost && avgCost > 0 ? avgCost : reference.price) : reference.price;
  const anchorLabel = anchor === avgCost ? "average cost" : "trigger price";

  if (avgCost && avgCost > 0 && avgCost !== reference.price) {
    levels.push({
      key: "cost_basis",
      label: "Position average cost",
      price: avgCost,
      distancePct: avgCost / reference.price - 1,
      basis: "Book cost of the holding this decision applied to.",
    });
  }

  levels.push({
    key: "stop",
    label: "Protective stop",
    price: anchor * (1 - stop.pct),
    distancePct: (anchor * (1 - stop.pct)) / reference.price - 1,
    basis: `${pctText(stop.pct)} below ${anchorLabel} — ${stop.basis}.`,
  });

  if (target) {
    levels.push({
      key: "target",
      label: "Profit target",
      price: anchor * (1 + target.pct),
      distancePct: (anchor * (1 + target.pct)) / reference.price - 1,
      basis: `${pctText(target.pct)} above ${anchorLabel} — ${target.basis}.`,
    });
  } else {
    notes.push("The take-profit leg is switched off for this portfolio — winners run until a stop or exit signal.");
  }

  const trailMult = n(cfg.atr_trailing_mult);
  if (trailMult != null && trailMult > 0) {
    const trailPct = trailMult * atrPct;
    levels.push({
      key: "trailing",
      label: "ATR trailing stop",
      price: reference.price * (1 - trailPct),
      distancePct: -trailPct,
      basis: `${pctText(trailPct)} below the running high — ATR ${pctText(atrPct)} × ${trailMult}.`,
    });
  }

  const riskPct = stop.pct;
  const rewardPct = target?.pct ?? null;

  return {
    side,
    referencePrice: reference.price,
    referenceSource: reference.source,
    currency: input.currency ?? null,
    atrPct: atrKnown ? (rawAtr as number) : null,
    atrSource: atrKnown ? "measured" : "assumed",
    levels,
    riskPct,
    rewardPct,
    riskReward: rewardPct != null && riskPct > 0 ? rewardPct / riskPct : null,
    maxHoldDays: n(cfg.max_hold_days),
    notes,
  };
}
