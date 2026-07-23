// Core trading engine. Called once per "tick" (day) for a portfolio.
// Uses AI SDK -> Lovable AI Gateway with structured output.

import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import {
  getDailyCandles,
  getPriceOn,
  sma,
  rsi,
  pctChange,
  dailyVolatility,
  type Candle,
} from "./market-data.server";
import { getNewsForDate } from "./news.server";
import {
  filterUniverse,
  findSymbol,
  riskProfile,
  parseRiskConfig,
  type UniverseSymbol,
} from "./universe.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";


type Portfolio = Database["public"]["Tables"]["portfolios"]["Row"];
type Holding = Database["public"]["Tables"]["holdings"]["Row"];

const OrderSchema = z.object({
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  // Percentage of current cash to allocate (for buys) OR percentage of holding to sell.
  percent: z.number(),
  reason: z.string(),
});

const DecisionSchema = z.object({
  briefing: z.string(),
  rationale: z.string(),
  orders: z.array(OrderSchema),
});

export type DecisionOutput = z.infer<typeof DecisionSchema>;

function classesFromUniverse(u: unknown): Database["public"]["Enums"]["asset_class"][] {
  if (!Array.isArray(u)) return ["stock", "etf", "crypto", "commodity", "fx"];
  return u.filter(
    (x): x is Database["public"]["Enums"]["asset_class"] =>
      typeof x === "string" && ["stock", "etf", "crypto", "commodity", "fx"].includes(x),
  );
}

async function buildCandidateFeatures(
  candidates: UniverseSymbol[],
  asOf: string,
) {
  const rows: Array<{
    symbol: string;
    name: string;
    asset_class: string;
    price: number;
    sma20: number | null;
    sma50: number | null;
    rsi14: number | null;
    change5d: number | null;
    change30d: number | null;
  }> = [];
  await Promise.all(
    candidates.map(async (c) => {
      const candles = await getDailyCandles(c.symbol, 90, asOf);
      if (candles.length < 5) return;
      const closes = candles.map((k) => k.close);
      rows.push({
        symbol: c.symbol,
        name: c.name,
        asset_class: c.asset_class,
        price: closes[closes.length - 1],
        sma20: sma(closes, 20),
        sma50: sma(closes, 50),
        rsi14: rsi(closes, 14),
        change5d: pctChange(closes, 5),
        change30d: pctChange(closes, 30),
      });
    }),
  );
  return rows;
}

export type ExecutedTrade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value: number;
  reason: string;
  rejected?: string;
};

async function callAiForDecision(args: {
  portfolio: Portfolio;
  holdings: Holding[];
  cashValue: number;
  totalValue: number;
  features: Awaited<ReturnType<typeof buildCandidateFeatures>>;
  news: { headline: string; source: string | null }[];
  asOf: string;
}): Promise<DecisionOutput> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("google/gemini-3.6-flash");

  const risk = riskProfile(args.portfolio.risk_level);

  const holdingsSummary = args.holdings.map((h) => ({
    symbol: h.symbol,
    quantity: Number(h.quantity),
    avg_cost: Number(h.avg_cost),
  }));

  const system = `You are a disciplined portfolio manager running a ${args.portfolio.currency} ${args.portfolio.starting_cash} paper-trading account.
HARD RULES YOU MUST NEVER BREAK:
- No borrowing, no margin, no shorting, no leverage, no derivatives.
- Cash balance must never go negative.
- No single position may exceed ${(risk.maxPositionPct * 100).toFixed(0)}% of portfolio value.
- Keep at least ${(risk.cashFloorPct * 100).toFixed(0)}% of portfolio value in cash.
- Open at most ${risk.maxNewPositionsPerDay} NEW positions per day.
- Only trade the provided symbols.
Style: ${args.portfolio.risk_level} risk. Explain concisely. Prefer inaction if uncertain.`;

  const user = `Date: ${args.asOf}
Portfolio value: ${args.totalValue.toFixed(2)} ${args.portfolio.currency}
Cash: ${args.cashValue.toFixed(2)} ${args.portfolio.currency}
Current holdings: ${JSON.stringify(holdingsSummary)}

Candidate assets (technicals):
${JSON.stringify(args.features, null, 2)}

Recent headlines:
${args.news
  .slice(0, 12)
  .map((n, i) => `${i + 1}. [${n.source ?? "news"}] ${n.headline}`)
  .join("\n")}

Return:
- briefing: 2-3 sentences on market context today.
- rationale: 2-4 sentences explaining today's actions.
- orders: array of trades to place today. Each order has:
    symbol (must be from candidate list),
    side ("buy" or "sell"),
    percent (for BUY: % of current cash to spend, 1-100; for SELL: % of the held quantity to sell, 1-100),
    reason (one sentence).
If no action is warranted, return an empty orders array.`;

  try {
    const { output } = await generateText({
      model,
      system,
      prompt: user,
      output: Output.object({ schema: DecisionSchema }),
    });
    return output;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return {
        briefing: "AI response could not be parsed; taking no action today.",
        rationale: error.text?.slice(0, 500) ?? "Parse error",
        orders: [],
      };
    }
    throw error;
  }
}

async function currentPrices(symbols: string[], asOf: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    symbols.map(async (s) => {
      const p = await getPriceOn(s, asOf);
      if (p != null) out.set(s, p);
    }),
  );
  return out;
}

export async function runDailyTick(portfolioId: string, asOf: string, opts?: { skipNews?: boolean }) {
  const { data: portfolio, error: pErr } = await supabaseAdmin
    .from("portfolios")
    .select("*")
    .eq("id", portfolioId)
    .single();
  if (pErr || !portfolio) throw new Error(pErr?.message ?? "Portfolio not found");

  const { data: holdings } = await supabaseAdmin
    .from("holdings")
    .select("*")
    .eq("portfolio_id", portfolioId);

  const universe = filterUniverse(classesFromUniverse(portfolio.universe));

  // Prices for holdings + top candidates
  const candidateSymbols = universe.slice(0, 22); // keep prompt bounded
  const allSymbols = Array.from(
    new Set([...(holdings ?? []).map((h) => h.symbol), ...candidateSymbols.map((c) => c.symbol)]),
  );
  const priceMap = await currentPrices(allSymbols, asOf);

  const cash = Number(portfolio.current_cash);
  const holdingsValue = (holdings ?? []).reduce((sum, h) => {
    const p = priceMap.get(h.symbol) ?? Number(h.avg_cost);
    return sum + p * Number(h.quantity);
  }, 0);
  const totalValue = cash + holdingsValue;

  const features = await buildCandidateFeatures(candidateSymbols, asOf);
  const news = opts?.skipNews ? [] : await getNewsForDate(asOf).catch(() => []);

  const decision = await callAiForDecision({
    portfolio,
    holdings: holdings ?? [],
    cashValue: cash,
    totalValue,
    features,
    news,
    asOf,
  });

  // Execute orders through guardrails
  const risk = riskProfile(portfolio.risk_level);
  const cashFloor = totalValue * risk.cashFloorPct;
  const maxPosVal = totalValue * risk.maxPositionPct;

  let workingCash = cash;
  const holdingsByS = new Map((holdings ?? []).map((h) => [h.symbol, { ...h }] as const));
  const executed: ExecutedTrade[] = [];
  let newPositions = 0;

  // Process sells first to free cash
  const sorted = [...decision.orders].sort((a) =>
    a.side === "sell" ? -1 : 1,
  );

  for (const order of sorted) {
    const sym = order.symbol.toUpperCase();
    const meta = findSymbol(sym);
    if (!meta) {
      executed.push({
        symbol: sym,
        side: order.side,
        quantity: 0,
        price: 0,
        value: 0,
        reason: order.reason,
        rejected: "symbol not in universe",
      });
      continue;
    }
    const price = priceMap.get(meta.symbol);
    if (!price || price <= 0) {
      executed.push({
        symbol: meta.symbol,
        side: order.side,
        quantity: 0,
        price: 0,
        value: 0,
        reason: order.reason,
        rejected: "no price available",
      });
      continue;
    }
    const pct = Math.max(0, Math.min(100, order.percent)) / 100;

    if (order.side === "sell") {
      const cur = holdingsByS.get(meta.symbol);
      if (!cur || Number(cur.quantity) <= 0) {
        executed.push({
          symbol: meta.symbol,
          side: "sell",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: "no holding to sell",
        });
        continue;
      }
      const qty = Number(cur.quantity) * pct;
      const value = qty * price;
      workingCash += value;
      const remaining = Number(cur.quantity) - qty;
      if (remaining <= 1e-8) holdingsByS.delete(meta.symbol);
      else holdingsByS.set(meta.symbol, { ...cur, quantity: remaining });
      executed.push({
        symbol: meta.symbol,
        side: "sell",
        quantity: qty,
        price,
        value,
        reason: order.reason,
      });
    } else {
      // BUY
      const isNewPosition = !holdingsByS.has(meta.symbol);
      if (isNewPosition && newPositions >= risk.maxNewPositionsPerDay) {
        executed.push({
          symbol: meta.symbol,
          side: "buy",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: "daily new-position cap reached",
        });
        continue;
      }
      const spendableCash = Math.max(0, workingCash - cashFloor);
      let spend = spendableCash * pct;
      // Enforce max position size
      const existingVal = holdingsByS.get(meta.symbol)
        ? Number(holdingsByS.get(meta.symbol)!.quantity) * price
        : 0;
      const roomInPosition = Math.max(0, maxPosVal - existingVal);
      spend = Math.min(spend, roomInPosition);
      if (spend < 1) {
        executed.push({
          symbol: meta.symbol,
          side: "buy",
          quantity: 0,
          price,
          value: 0,
          reason: order.reason,
          rejected: "guardrails leave no room to buy",
        });
        continue;
      }
      const qty = spend / price;
      workingCash -= spend;
      if (isNewPosition) newPositions += 1;
      const cur = holdingsByS.get(meta.symbol);
      if (cur) {
        const newQty = Number(cur.quantity) + qty;
        const newCost =
          (Number(cur.avg_cost) * Number(cur.quantity) + spend) / newQty;
        holdingsByS.set(meta.symbol, { ...cur, quantity: newQty, avg_cost: newCost });
      } else {
        holdingsByS.set(meta.symbol, {
          id: crypto.randomUUID(),
          portfolio_id: portfolioId,
          symbol: meta.symbol,
          asset_class: meta.asset_class,
          quantity: qty,
          avg_cost: price,
          updated_at: new Date().toISOString(),
        } as Holding);
      }
      executed.push({
        symbol: meta.symbol,
        side: "buy",
        quantity: qty,
        price,
        value: spend,
        reason: order.reason,
      });
    }
  }

  // Persist state
  const admin = supabaseAdmin;
  const executedAt = new Date().toISOString();

  // Insert trades (only executed ones with quantity > 0)
  const tradesRows = executed
    .filter((t) => t.quantity > 0)
    .map((t) => ({
      portfolio_id: portfolioId,
      symbol: t.symbol,
      asset_class: findSymbol(t.symbol)!.asset_class,
      side: t.side,
      quantity: t.quantity,
      price: t.price,
      value: t.value,
      executed_at: executedAt,
      trade_date: asOf,
      reason: t.reason + (t.rejected ? ` [REJECTED: ${t.rejected}]` : ""),
    }));
  if (tradesRows.length > 0) await admin.from("trades").insert(tradesRows);

  // Replace holdings: delete then insert (simpler & atomic-enough for paper account)
  await admin.from("holdings").delete().eq("portfolio_id", portfolioId);
  const holdingsRows = Array.from(holdingsByS.values())
    .filter((h) => Number(h.quantity) > 1e-8)
    .map((h) => ({
      portfolio_id: portfolioId,
      symbol: h.symbol,
      asset_class: h.asset_class,
      quantity: Number(h.quantity),
      avg_cost: Number(h.avg_cost),
    }));
  if (holdingsRows.length > 0) await admin.from("holdings").insert(holdingsRows);

  // Recompute portfolio value with latest holdings
  const newHoldingsValue = Array.from(holdingsByS.values()).reduce((sum, h) => {
    const p = priceMap.get(h.symbol) ?? Number(h.avg_cost);
    return sum + p * Number(h.quantity);
  }, 0);
  const newTotal = workingCash + newHoldingsValue;

  await admin
    .from("portfolios")
    .update({ current_cash: workingCash, last_run_date: asOf })
    .eq("id", portfolioId);

  await admin.from("equity_snapshots").upsert(
    {
      portfolio_id: portfolioId,
      snapshot_date: asOf,
      cash: workingCash,
      holdings_value: newHoldingsValue,
      total_value: newTotal,
    },
    { onConflict: "portfolio_id,snapshot_date" },
  );

  await admin.from("decisions").insert({
    portfolio_id: portfolioId,
    run_date: asOf,
    briefing: decision.briefing,
    rationale: decision.rationale,
    model: "google/gemini-3.6-flash",
    portfolio_value: newTotal,
    raw: {
      orders: decision.orders,
      executed,
      signals: features,
      news: news.slice(0, 12),
      guardrails: {
        risk_level: portfolio.risk_level,
        max_position_pct: risk.maxPositionPct,
        cash_floor_pct: risk.cashFloorPct,
        max_new_positions_per_day: risk.maxNewPositionsPerDay,
        cash_floor_value: cashFloor,
        max_position_value: maxPosVal,
        starting_total_value: totalValue,
        starting_cash: cash,
      },
    } as unknown as never,
  });

  return { decision, executed, totalValue: newTotal, cash: workingCash };
}

// Snapshot the portfolio value on a date without calling the AI (for backtest fill-in).
export async function snapshotPortfolio(portfolioId: string, asOf: string) {
  const { data: portfolio } = await supabaseAdmin
    .from("portfolios")
    .select("current_cash")
    .eq("id", portfolioId)
    .single();
  if (!portfolio) return;
  const { data: holdings } = await supabaseAdmin
    .from("holdings")
    .select("symbol, quantity, avg_cost")
    .eq("portfolio_id", portfolioId);

  const priceMap = await currentPrices(
    (holdings ?? []).map((h) => h.symbol),
    asOf,
  );
  const hv = (holdings ?? []).reduce((s, h) => {
    const p = priceMap.get(h.symbol) ?? Number(h.avg_cost);
    return s + p * Number(h.quantity);
  }, 0);
  const cash = Number(portfolio.current_cash);
  await supabaseAdmin.from("equity_snapshots").upsert(
    {
      portfolio_id: portfolioId,
      snapshot_date: asOf,
      cash,
      holdings_value: hv,
      total_value: cash + hv,
    },
    { onConflict: "portfolio_id,snapshot_date" },
  );
}
