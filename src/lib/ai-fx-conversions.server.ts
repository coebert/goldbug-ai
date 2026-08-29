// FX strategy support for the AI trading engine.
//
// Gives the model a per-currency wallet snapshot, exposure-by-currency,
// live FX rates, and the FX circuit-breaker status, plus a compact playbook
// for when to shift cash between currencies (pre-funding foreign buys,
// hedging unwanted exposure, closing idle non-base cash pockets, staying out
// of FX while the circuit is open or rates are stale).
//
// Conversions the AI proposes are applied here in wallet-book mode:
// planFxConversion computes the resulting wallet and we update
// portfolios.cash_by_ccy + current_cash under the admin client. Broker-side
// spot FX during a daily tick is intentionally out of scope; the executor
// handles broker legs when placing dependent buys.

import { z } from "zod";
import { getFxPairSignals, type FxPairSignals } from "./fx-signals.server";
import { getFxMatrix, getFxRate } from "./fx.server";
import { planFxConversion } from "./fx-convert-plan";
import { readWallet, walletBalance, writeWalletFields, type Wallet } from "./portfolio-wallet";
import { getFxCircuitState } from "./fx-circuit.server";
import { parseFxPair, valueFxLeg } from "./fx-leg-quotes";
import { asJson } from "./_server/db-json";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  applyFxCost,
  quoteFxCost,
  summarizeRoundTripCosts,
} from "./fx-cost-model";


export const FxConversionOrderSchema = z.object({
  from_ccy: z.string().length(3),
  to_ccy: z.string().length(3),
  // Percent of the from-currency wallet balance to convert (1..100).
  amount_percent: z.number().min(1).max(100),
  reason: z.string(),
});
export type FxConversionOrder = z.infer<typeof FxConversionOrderSchema>;

const SUPPORTED = ["GBP", "USD", "EUR", "CHF", "JPY", "CAD", "AUD"] as const;

/**
 * Best-effort mapping from a Yahoo-style ticker to its trading currency.
 * Matches the assumptions used in live-executor.server.ts for symToCcy.
 */
export function inferSymbolCurrency(symbol: string, portfolioCcy: string): string {
  const s = symbol.toUpperCase();
  if (s.endsWith(".L")) return "GBP";
  if (s.endsWith(".T") || s.endsWith(":XTKS")) return "JPY";
  if (s.endsWith(".AX") || s.endsWith(":XASX")) return "AUD";
  if (s.endsWith(".DE") || s.endsWith(".PA") || s.endsWith(".MI") || s.endsWith(".AS")) return "EUR";
  if (s.endsWith(".SW")) return "CHF";
  if (s.endsWith(".TO")) return "CAD";
  if (s.endsWith("-USD")) return "USD";
  if (s.endsWith("=F")) return "USD";
  if (s.endsWith("=X")) return "USD"; // FX pairs settle via quote ccy — treat as USD-denominated notional here
  if (/^[A-Z.]+$/.test(s)) return "USD"; // US-listed default
  return (portfolioCcy || "USD").toUpperCase();
}

export interface FxContext {
  active: boolean;              // portfolio.fx_enabled === true
  circuitOpen: boolean;
  circuitReason: string | null;
  baseCcy: string;
  wallet: Wallet;
  matrix: Map<string, { rate: number; source: string; stale?: boolean }>;
  currenciesInPlay: string[];
  exposureByCcy: Record<string, number>; // in base ccy
  block: string;                // system-prompt block (playbook + status)
  contextBlock: string;         // user-prompt block (numbers)
  /** Open FX spot funding legs marked to the CURRENT rate. */
  openLegs: FxOpenLeg[];
}

export type FxOpenLeg = {
  symbol: string;
  quantity: number;      // signed units of the pair's base ccy
  entryRate: number;
  rate: number | null;   // live mark, null when the pair is unavailable
  stale: boolean;
  pnlQuote: number;
  pnlBase: number;
  pnlPct: number;        // P&L as % of the leg's notional
  notionalBase: number;
  base: string;
  quote: string;
};

/**
 * Build the FX context block for the AI prompt. Safe to call even when
 * fx_enabled is false — returns an inactive context and a short message
 * telling the model FX is disabled.
 */
export async function buildFxContext(args: {
  portfolio: {
    id: string;
    currency: string | null;
    current_cash: number | null;
    cash_by_ccy?: unknown;
    fx_enabled?: boolean | null;
  };
  holdings: Array<{
    symbol: string;
    quantity: number | string;
    avg_cost?: number | string | null;
    asset_class?: string | null;
  }>;
  priceMap: Map<string, number>;
  candidateSymbols: string[];
}): Promise<FxContext> {
  const baseCcy = (args.portfolio.currency || "GBP").toUpperCase();
  const rawCash = args.portfolio.cash_by_ccy;
  const cashByCcy =
    rawCash && typeof rawCash === "object" && !Array.isArray(rawCash)
      ? (rawCash as Record<string, number>)
      : null;
  const wallet = readWallet({
    currency: baseCcy,
    current_cash: args.portfolio.current_cash,
    cash_by_ccy: cashByCcy,
  });

  const active = args.portfolio.fx_enabled === true;

  const holdingCcys = new Set<string>();
  const exposureByCcy: Record<string, number> = {};
  for (const h of args.holdings) {
    const ccy = inferSymbolCurrency(h.symbol, baseCcy);
    holdingCcys.add(ccy);
    const price = args.priceMap.get(h.symbol) ?? 0;
    const nativeValue = price * Number(h.quantity);
    exposureByCcy[ccy] = (exposureByCcy[ccy] ?? 0) + nativeValue;
  }
  const candidateCcys = new Set(args.candidateSymbols.map((s) => inferSymbolCurrency(s, baseCcy)));
  const walletCcys = new Set(Object.keys(wallet));
  const all = new Set<string>([baseCcy, ...walletCcys, ...holdingCcys, ...candidateCcys, ...SUPPORTED]);
  const currenciesInPlay = Array.from(all).sort();

  // Build the FX matrix vs base currency (both directions) and pair-vs-pair
  // for anything the model might rebalance between.
  const pairs: Array<{ from: string; to: string }> = [];
  for (const c of currenciesInPlay) {
    if (c !== baseCcy) {
      pairs.push({ from: c, to: baseCcy });
      pairs.push({ from: baseCcy, to: c });
    }
  }
  let matrix: FxContext["matrix"] = new Map();
  try {
    matrix = await getFxMatrix(pairs);
  } catch {
    matrix = new Map();
  }

  // Convert native exposure → base ccy for the summary.
  const exposureBase: Record<string, number> = {};
  for (const [ccy, native] of Object.entries(exposureByCcy)) {
    if (ccy === baseCcy) {
      exposureBase[ccy] = Math.round(native * 100) / 100;
      continue;
    }
    const q = matrix.get(`${ccy}${baseCcy}`);
    if (q && Number.isFinite(q.rate)) {
      exposureBase[ccy] = Math.round(native * q.rate * 100) / 100;
    }
  }

  let circuitOpen = false;
  let circuitReason: string | null = null;
  try {
    const c = await getFxCircuitState(supabaseAdmin, args.portfolio.id);
    circuitOpen = c.open;
    circuitReason = c.reason;
  } catch {
    // treat unknown as closed — the executor's own guards remain in force
  }

  // Open FX spot funding legs, marked to the CURRENT rate. Without this the
  // model could see live rates but not the position those rates move, so it
  // never reacted to a funding leg drifting against the account.
  const openLegs: FxOpenLeg[] = [];
  for (const h of args.holdings) {
    if (String(h.asset_class ?? "").toLowerCase() !== "fx") continue;
    const qty = Number(h.quantity);
    const entry = Number(h.avg_cost);
    const pair = parseFxPair(String(h.symbol));
    if (!pair || !Number.isFinite(qty) || qty === 0 || !Number.isFinite(entry) || entry <= 0) continue;
    const q = matrix.get(`${pair.base}${pair.quote}`);
    const rate = q && Number.isFinite(q.rate) && q.rate > 0 ? q.rate : null;
    const quoteToBase =
      pair.quote === baseCcy ? 1 : (matrix.get(`${pair.quote}${baseCcy}`)?.rate ?? 1);
    const v = valueFxLeg({ quantity: qty, avgCost: entry, rate: rate ?? entry, quoteToBase });
    openLegs.push({
      symbol: String(h.symbol).toUpperCase(),
      quantity: qty,
      entryRate: entry,
      rate,
      stale: rate == null || q?.stale === true,
      pnlQuote: v.pnlQuote,
      pnlBase: v.pnlBase,
      pnlPct: rate ? ((rate - entry) / entry) * 100 * (qty < 0 ? -1 : 1) : 0,
      notionalBase: v.notionalBase,
      base: pair.base,
      quote: pair.quote,
    });
  }

  if (!active) {
    return {
      openLegs,
      active: false,
      circuitOpen,
      circuitReason,
      baseCcy,
      wallet,
      matrix,
      currenciesInPlay,
      exposureByCcy: exposureBase,
      block: "FX STRATEGY: multi-currency wallet is disabled on this portfolio. Do not propose fx_conversions; they will be rejected.",
      contextBlock: "",
    };
  }

  const walletRows = Object.entries(wallet)
    .filter(([, v]) => Math.abs(v) > 0.005 || Object.keys(wallet).length <= 2)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([c, v]) => `- ${c}: ${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    .join("\n");

  const ratesRows = Array.from(matrix.entries())
    .filter(([k]) => k.endsWith(baseCcy) && !k.startsWith(baseCcy))
    .sort()
    .map(([k, v]) => {
      const from = k.slice(0, 3);
      const flags: string[] = [];
      if (v.stale) flags.push("STALE");
      if (v.source?.startsWith("fallback")) flags.push("FALLBACK");
      return `- ${from}→${baseCcy} ${v.rate.toFixed(4)}${flags.length ? ` [${flags.join(",")}]` : ""} (src: ${v.source ?? "?"})`;
    })
    .join("\n");

  const exposureRows = Object.entries(exposureBase)
    .filter(([, v]) => Math.abs(v) > 0.5)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([c, v]) => `- ${c}: ${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${baseCcy}`)
    .join("\n");

  const circuitLine = circuitOpen
    ? `- FX CIRCUIT: OPEN (${circuitReason ?? "identity-fallback in effect"}). Do NOT propose fx_conversions this tick — they will be rejected.`
    : `- FX CIRCUIT: closed. Conversions are allowed subject to rate quality.`;

  // Signals: momentum + vol + event proximity for every non-base ccy vs base.
  // Best-effort — failures degrade to null fields rather than blocking the tick.
  const signalCcys = currenciesInPlay.filter((c) => c !== baseCcy).slice(0, 6);
  const signals: FxPairSignals[] = await Promise.all(
    signalCcys.map((c) =>
      getFxPairSignals(c, baseCcy).catch(() =>
        ({
          from: c,
          to: baseCcy,
          latest: null,
          ret5dPct: null,
          ret20dPct: null,
          ret60dPct: null,
          vol20dPct: null,
          distSma50Pct: null,
          trendBias: "neutral",
          eventWithin24h: [],
          source: "error",
          stale: true,
        }) as FxPairSignals,
      ),
    ),
  );
  const fmt = (n: number | null, digits = 2) =>
    n == null || !Number.isFinite(n) ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
  const signalsRows = signals
    .map((s) => {
      const ev = s.eventWithin24h.length > 0
        ? ` [EVENT ≤24h: ${s.eventWithin24h.map((e) => `${e.ccy} ${e.label}`).join(", ")}]`
        : "";
      const stale = s.stale ? " [STALE]" : "";
      return `- ${s.from}→${s.to}: 5d ${fmt(s.ret5dPct)}, 20d ${fmt(s.ret20dPct)}, 60d ${fmt(s.ret60dPct)}, vol20 ${fmt(s.vol20dPct, 1)}, distSMA50 ${fmt(s.distSma50Pct)}, bias ${s.trendBias}${ev}${stale}`;
    })
    .join("\n");

  // Per-pair FX conversion cost table. Encodes the spread + wallet markup
  // the AI must subtract from an expected return before entering (or holding)
  // a foreign-currency position. JPY/AUD crosses are wider than EURUSD.
  const costCcys = currenciesInPlay.filter((c) => c !== baseCcy);
  const walletCosts = summarizeRoundTripCosts(baseCcy, costCcys, "wallet");
  const spotCosts = summarizeRoundTripCosts(baseCcy, costCcys, "spot");
  const spotByCcy = new Map(spotCosts.map((r) => [r.ccy, r]));
  const costRows = walletCosts
    .map((r) => {
      const spot = spotByCcy.get(r.ccy);
      const spotLbl = spot ? `${spot.totalBps}bps` : "n/a";
      return `- ${baseCcy}↔${r.ccy} (${r.pairClass}): entry ${r.entryBps}bps, exit ${r.exitBps}bps, round-trip ${r.totalBps}bps wallet / ${spotLbl} spot`;
    })
    .join("\n");

  const contextBlock = `FX WALLET & EXPOSURE (base = ${baseCcy}):
Wallet balances:
${walletRows || "- (empty)"}

Native exposure of current holdings converted to ${baseCcy}:
${exposureRows || "- (none)"}

FX rates vs base:
${ratesRows || "- (unavailable)"}
${circuitLine}

FX CONVERSION COSTS (mid → effective, bps deducted per leg):
${costRows || "- (base only)"}

FX pair signals (vs ${baseCcy}):
${signalsRows || "- (unavailable)"}

OPEN FX FUNDING LEGS (marked to the current rate this tick):
${
  openLegs.length
    ? openLegs
        .map(
          (l) =>
            `- ${l.symbol} ${l.quantity.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${l.base} @ ${l.entryRate.toFixed(4)} entry, now ${l.rate == null ? "unavailable" : l.rate.toFixed(4)}${l.stale ? " [STALE]" : ""} → close-now P&L ${l.pnlBase >= 0 ? "+" : ""}${l.pnlBase.toFixed(2)} ${baseCcy} (${l.pnlPct >= 0 ? "+" : ""}${l.pnlPct.toFixed(2)}% of a ${l.notionalBase.toFixed(0)} ${baseCcy} notional)`,
        )
        .join("\n")
    : "- (none)"
}`;


  // Rewritten playbook: concrete, rule-based, references the fields the
  // model actually sees above so its rationale can cite specific values.
  const playbook = `FX STRATEGY (multi-currency wallet is enabled). Base = ${baseCcy}.
Decision rules — evaluate in order, stop at the first that fires:

1. STAND DOWN (no new conversions this tick) if ANY of:
   • FX CIRCUIT is OPEN
   • the required pair is flagged STALE, FALLBACK, or "unavailable"
   • an EVENT ≤24h is flagged for either side of the pair (except close_hedge / sweep_idle)

2. PRE-FUND FOREIGN BUYS
   If you also propose a BUY denominated in ccy X and wallet[X] is below the
   buy notional, convert exactly (shortfall × 1.02) from ${baseCcy}→X. Do
   this even if the pair signals are neutral — funding beats waiting.

3. HEDGE / REDUCE FX EXPOSURE
   If exposureByCcy[X] > 60% of NAV AND (regime is bear_volatile/crisis OR
   vol20 for X→${baseCcy} > 15%), convert 25–50% of wallet[X] back to
   ${baseCcy}. Never sell equities purely to raise FX.

4. SWEEP IDLE
   If wallet[X] < 1% of NAV AND no BUY in X this tick AND no upcoming event,
   convert 100% of wallet[X] back to ${baseCcy} (fee guard: skip if amount < ~£25 equivalent).

5. CARRY / MOMENTUM TILT (only in regime = risk-on/neutral)
   If trendBias for X→${baseCcy} is long_from AND 60d return > 2% AND vol20 < 12%,
   tilt up to 10% of ${baseCcy} wallet into X. Cap total tilt exposure at 20% NAV.

6. CLOSE HEDGE
   If a prior hedge was opened and the trigger (exposure or vol) has cleared,
   unwind it — allowed even inside STAND DOWN if pair quality is acceptable.

SAFETY:
- Never convert more than 40% of any single currency's balance in a single tick.
- Every leg pays the pair-specific spread shown in FX CONVERSION COSTS above.
  A JPY or AUD entry only makes sense when the expected forward return
  exceeds the round-trip cost with margin — cite that math in your reason.
- Every fx_conversion.reason MUST cite the rule number and the numeric trigger
  (e.g. "rule 3: exposureUSD 63% of NAV, vol20 18.4%").


Format: fx_conversions is an array of { from_ccy, to_ccy, amount_percent (1..100 of the from balance), reason }.`;

  return {
    openLegs,
    active: true,
    circuitOpen,
    circuitReason,
    baseCcy,
    wallet,
    matrix,
    currenciesInPlay,
    exposureByCcy: exposureBase,
    block: playbook,
    contextBlock,
  };
}


export interface AppliedFxConversion {
  from_ccy: string;
  to_ccy: string;
  amount_from: number;
  amount_to: number;
  rate: number;
  source: string;
  reason: string;
  rejected?: string;
}

export interface ApplyFxResult {
  applied: AppliedFxConversion[];
  newWallet: Wallet;
  baseCashDelta: number; // change in base-ccy wallet balance (for updating workingCash)
}

/**
 * Apply the AI's fx_conversions to the wallet in book-entry mode.
 * Uses the same quote source and math as the manual convert flow. Persists
 * the resulting cash_by_ccy + current_cash under the admin client.
 */
export async function applyAiFxConversions(args: {
  portfolioId: string;
  userId: string;
  baseCcy: string;
  wallet: Wallet;
  conversions: FxConversionOrder[];
  fxContext: FxContext;
  buyHalts: boolean;
  persist: boolean;
}): Promise<ApplyFxResult> {
  const applied: AppliedFxConversion[] = [];
  let wallet: Wallet = { ...args.wallet };
  const startingBase = walletBalance(wallet, args.baseCcy);

  for (const raw of args.conversions) {
    const from = raw.from_ccy.toUpperCase();
    const to = raw.to_ccy.toUpperCase();
    const base: AppliedFxConversion = {
      from_ccy: from,
      to_ccy: to,
      amount_from: 0,
      amount_to: 0,
      rate: 0,
      source: "",
      reason: raw.reason,
    };

    if (!args.fxContext.active) {
      applied.push({ ...base, rejected: "fx wallet disabled on portfolio" });
      continue;
    }
    if (args.fxContext.circuitOpen) {
      applied.push({ ...base, rejected: `fx circuit open: ${args.fxContext.circuitReason ?? "identity-fallback"}` });
      continue;
    }
    if (args.buyHalts) {
      // Risk-halts pause de-risking-adjacent activity; keep FX moves off too.
      applied.push({ ...base, rejected: "risk halt active" });
      continue;
    }
    if (from === to) {
      applied.push({ ...base, rejected: "from and to currencies match" });
      continue;
    }

    const balance = walletBalance(wallet, from);
    const pct = Math.min(100, Math.max(1, raw.amount_percent));
    // Enforce the playbook cap of 40% per currency per tick regardless of what
    // the model asks for; still respect an explicit lower percent.
    const cappedPct = Math.min(pct, 40);
    const amountFrom = Math.floor(balance * (cappedPct / 100) * 100) / 100;
    if (amountFrom < 1) {
      applied.push({ ...base, rejected: `insufficient ${from} balance (${balance.toFixed(2)})` });
      continue;
    }

    let rate = 0;
    let source = "";
    try {
      const q = await getFxRate(from, to);
      if (!Number.isFinite(q.rate) || q.rate <= 0) {
        applied.push({ ...base, rejected: `no rate for ${from}->${to}` });
        continue;
      }
      if (q.stale) {
        applied.push({ ...base, rate: q.rate, source: q.source, rejected: `stale rate (${q.source})` });
        continue;
      }
      // Per-pair spread + wallet markup from the shared cost model — JPY/AUD
      // crosses price wider than EURUSD, exotics wider still.
      const costQuote = quoteFxCost(from, to, "wallet");
      rate = applyFxCost(q.rate, costQuote);
      source = `ai:${q.source}:${costQuote.pairClass}:${costQuote.totalBps}bps`;
    } catch (e) {
      applied.push({ ...base, rejected: e instanceof Error ? e.message : "fx quote failed" });
      continue;
    }


    const plan = planFxConversion({ wallet, from, to, amountFrom, rate });
    if (!plan.ok) {
      applied.push({ ...base, rate, source, rejected: plan.detail });
      continue;
    }

    wallet = plan.newWallet;
    applied.push({
      ...base,
      amount_from: plan.amountFrom,
      amount_to: plan.amountTo,
      rate,
      source,
    });
  }

  const endingBase = walletBalance(wallet, args.baseCcy);
  const baseCashDelta = endingBase - startingBase;

  if (args.persist && applied.some((a) => !a.rejected)) {
    const fields = writeWalletFields(wallet, args.baseCcy);
    try {
      await supabaseAdmin
        .from("portfolios")
        .update({
          cash_by_ccy: asJson(fields.cash_by_ccy),
        })
        .eq("id", args.portfolioId);
      // Best-effort audit trail (same log surface as the manual convert flow).
      for (const a of applied) {
        if (a.rejected) continue;
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: args.portfolioId,
          user_id: args.userId,
          broker: "internal",
          env: "sim",
          method: "FX_CONVERT_AI_WALLET",
          path: `/ai-fx/${a.from_ccy}->${a.to_ccy}`,
          status: 200,
          request: asJson({ amount_from: a.amount_from, reason: a.reason }),
          response: asJson({ amount_to: a.amount_to, rate: a.rate, source: a.source }),
          error: null,
        });
      }
    } catch (e) {
      console.warn("ai-fx persist failed", e);
    }
  }

  return { applied, newWallet: wallet, baseCashDelta };
}
