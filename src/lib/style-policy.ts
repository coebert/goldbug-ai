// Decision-policy seam for the trading-style backtest.
//
// The harness used to hard-wire the deterministic heuristic rule layer as the
// decision maker. This module defines the policy interface so the *actual* AI
// decision policy (same style prompt, same order schema as the live engine)
// can be dropped in instead, with the risk/exit engine unchanged around it.
//
// Pure and client-safe: prompt construction and response mapping live here so
// they are unit-testable without a network call.

import type { HeuristicFeature } from "./heuristic-decision";
import { tradingStylePrompt, minHoldDays } from "./trading-style";
import type { RiskConfig } from "./universe.server";
import type { RiskLevel } from "./risk-sim-matrix";

export type PolicyHolding = {
  symbol: string;
  quantity: number;
  avgCost: number;
  price: number;
  /** Bars held so far (0 on the entry bar). */
  heldBars: number;
};

export type PolicyContext = {
  barIndex: number;
  date: string;
  cfg: RiskConfig;
  riskLevel: RiskLevel;
  cash: number;
  equity: number;
  holdings: PolicyHolding[];
  /** Investable candidates with today's close and feature row. */
  candidates: Array<{
    symbol: string;
    price: number;
    feature: HeuristicFeature;
    atrPct: number;
    /** True when a post-exit re-entry lockout is still active. */
    locked: boolean;
  }>;
  /** Names already at the sleeve cap this bar. */
  maxNames: number;
  perNameWeight: number;
};

export type PolicyOrder = {
  symbol: string;
  side: "buy" | "sell";
  /** Share of total equity to allocate (buy) or of the position to close (sell), 0..1. */
  weight: number;
  reason: string;
};

export type StylePolicy = {
  name: string;
  /** Bars between decision calls. Exits still run every bar. */
  cadenceBars: number;
  decide: (ctx: PolicyContext) => Promise<PolicyOrder[]>;
};

const pct = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "-" : `${(v * 100).toFixed(d)}%`;
const num = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "-" : v.toFixed(d);

/**
 * The prompt the AI decision policy sees. Deliberately mirrors the live
 * engine's structure: style block, hard sizing rules, holdings table with
 * age/PnL, and a compact candidate feature table.
 */
export function buildStylePolicyPrompt(ctx: PolicyContext): string {
  const { cfg } = ctx;
  const invested = ctx.equity > 0 ? 1 - ctx.cash / ctx.equity : 0;
  const style = tradingStylePrompt(cfg);
  const minHold = minHoldDays(cfg);

  const holdings =
    ctx.holdings.length > 0
      ? ctx.holdings
          .map(
            (h) =>
              `- ${h.symbol} qty ${h.quantity} @ ${h.avgCost.toFixed(2)} | last ${h.price.toFixed(
                2,
              )} | pnl ${pct((h.price - h.avgCost) / h.avgCost)} | held ${h.heldBars}d | weight ${pct(
                (h.quantity * h.price) / Math.max(ctx.equity, 1e-9),
              )}`,
          )
          .join("\n")
      : "- none";

  const table = ctx.candidates
    .map(
      (c) =>
        `${c.symbol.padEnd(6)} px ${c.price.toFixed(2).padStart(8)}  rsi ${num(
          c.feature.rsi14,
          0,
        ).padStart(3)}  5d ${pct(c.feature.change5d).padStart(7)}  30d ${pct(
          c.feature.change30d,
        ).padStart(7)}  macd ${num(c.feature.macd_hist, 2).padStart(6)}  atr ${pct(
          c.atrPct,
          2,
        ).padStart(6)}${c.locked ? "  [re-entry locked]" : ""}`,
    )
    .join("\n");

  return [
    `DATE: ${ctx.date} (bar ${ctx.barIndex}).`,
    `ACCOUNT: equity ${ctx.equity.toFixed(0)}, cash ${ctx.cash.toFixed(0)} (${pct(
      1 - invested,
    )} of equity), invested ${pct(invested)}. Risk dial: ${ctx.riskLevel}.`,
    style || "TRADING STYLE: POSITION (multi-week to multi-month holds; ride established trends).",
    "",
    "HARD RULES (violations are rejected by the executor):",
    `- No shorting and no borrowing: never sell a name you do not hold, never spend below a ${pct(
      cfg.cash_floor_pct ?? 0.05,
    )} cash floor.`,
    `- At most ${ctx.maxNames} open names; a new position targets about ${pct(
      ctx.perNameWeight,
    )} of equity (less when ATR is high).`,
    `- Stop loss ${pct(cfg.stop_loss_pct)}, take profit ${pct(
      cfg.take_profit_pct,
    )}, and trailing/time stops are enforced automatically OUTSIDE your decision — do not restate them as orders.`,
    minHold > 0
      ? `- A position younger than ${minHold} session(s) must not be sold discretionarily.`
      : "- Avoid churning positions you opened in the last few sessions.",
    "- Names marked [re-entry locked] cannot be bought this bar; skip them.",
    "",
    "OPEN POSITIONS:",
    holdings,
    "",
    "CANDIDATES (close, RSI14, 5d and 30d change, MACD histogram, daily ATR%):",
    table,
    "",
    "MANDATE: this account is run to compound capital, not to sit in cash. Deploy into",
    `every candidate that meets the style's setup criteria, up to the ${ctx.maxNames}-name cap;`,
    "hold cash only where no candidate qualifies. Rank by trend, momentum and RSI position,",
    "and prefer the strongest setups when more qualify than you have room for.",
    "Decide today's discretionary orders — new entries and any discretionary exit of a",
    "holding whose thesis has broken. An empty order list is valid when nothing qualifies.",
    "For a buy, `weight`",
    "is the share of TOTAL EQUITY to allocate (0 to 1). For a sell, `weight` is the",
    "share of the existing position to close (use 1 to exit fully).",
  ].join("\n");
}

/** Clamp/sanitise raw model orders against the hard rules the harness enforces. */
export function sanitisePolicyOrders(
  raw: Array<{ symbol?: unknown; side?: unknown; weight?: unknown; reason?: unknown }>,
  ctx: PolicyContext,
): PolicyOrder[] {
  const held = new Map(ctx.holdings.map((h) => [h.symbol, h] as const));
  const tradable = new Set(ctx.candidates.map((c) => c.symbol));
  const locked = new Set(ctx.candidates.filter((c) => c.locked).map((c) => c.symbol));
  const minHold = minHoldDays(ctx.cfg);
  const seen = new Set<string>();
  const out: PolicyOrder[] = [];

  for (const o of raw ?? []) {
    const symbol = typeof o?.symbol === "string" ? o.symbol.trim().toUpperCase() : "";
    const side = o?.side === "sell" ? "sell" : o?.side === "buy" ? "buy" : null;
    const weightRaw = Number(o?.weight);
    if (!symbol || !side || !Number.isFinite(weightRaw) || weightRaw <= 0) continue;
    if (seen.has(symbol)) continue;

    // Percent-style outputs (e.g. 25 meaning 25%) are normalised, not trusted raw.
    const weight = Math.min(1, weightRaw > 1 ? weightRaw / 100 : weightRaw);
    if (!(weight > 0)) continue;

    if (side === "sell") {
      const h = held.get(symbol);
      if (!h || !(h.quantity > 0)) continue; // no shorting
      if (minHold > 0 && h.heldBars < minHold) continue; // churn guard
    } else {
      if (!tradable.has(symbol)) continue;
      if (locked.has(symbol)) continue;
      if (held.has(symbol)) continue; // no pyramiding in this harness
      if (held.size + out.filter((x) => x.side === "buy").length >= ctx.maxNames) continue;
    }

    seen.add(symbol);
    out.push({
      symbol,
      side,
      weight,
      reason: typeof o?.reason === "string" && o.reason ? o.reason.slice(0, 200) : "ai",
    });
  }
  return out;
}
