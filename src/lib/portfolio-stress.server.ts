// H. Portfolio-level Value-at-Risk + scenario stress panel.
// Historical VaR uses 60d realised returns of current holdings weighted by
// their portfolio value. Scenarios shock equity / rates / USD linearly by
// asset class.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDailyCandles } from "./market-data.server";

export type StressResult = {
  var95_pct: number | null;
  var95_value: number | null;
  cvar95_pct: number | null;
  n_days: number;
  total_value: number;
  scenarios: Array<{ name: string; impact_pct: number; impact_value: number; note: string }>;
  weights: Array<{ symbol: string; asset_class: string; weight_pct: number }>;
};

const SCENARIOS = [
  { name: "2008-style equity −8%", stock: -0.08, etf: -0.06, crypto: -0.15, commodity: -0.04, fx: -0.01 },
  { name: "Rates +50bps shock", stock: -0.02, etf: -0.02, crypto: -0.03, commodity: 0.0, fx: 0.005 },
  { name: "USD +2% strength", stock: -0.01, etf: -0.005, crypto: -0.02, commodity: -0.03, fx: 0.02 },
  { name: "Vol spike (VIX +50%)", stock: -0.04, etf: -0.03, crypto: -0.08, commodity: -0.02, fx: 0.0 },
] as const;

type Cls = keyof (typeof SCENARIOS)[number];

export async function computePortfolioStress(portfolioId: string, asOf: string): Promise<StressResult> {
  const { data: p } = await supabaseAdmin
    .from("portfolios")
    .select("current_cash")
    .eq("id", portfolioId)
    .single();
  const { data: holdings } = await supabaseAdmin
    .from("holdings")
    .select("symbol, quantity, avg_cost, asset_class")
    .eq("portfolio_id", portfolioId);

  const cash = Number(p?.current_cash ?? 0);
  const list = (holdings ?? []).filter((h) => Number(h.quantity) > 0);
  if (list.length === 0) {
    return {
      var95_pct: null, var95_value: null, cvar95_pct: null, n_days: 0,
      total_value: cash, scenarios: [], weights: [],
    };
  }

  // Latest prices + 60d returns per symbol
  const perSymbol = await Promise.all(list.map(async (h) => {
    const candles = await getDailyCandles(h.symbol, 65, asOf).catch(() => []);
    if (candles.length < 20) return null;
    const closes = candles.map((c) => c.close);
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const price = closes[closes.length - 1];
    return { symbol: h.symbol, asset_class: h.asset_class as string, value: Number(h.quantity) * price, rets };
  }));

  const rows = perSymbol.filter((r): r is NonNullable<typeof r> => r != null);
  const holdingsValue = rows.reduce((s, r) => s + r.value, 0);
  const total = cash + holdingsValue;

  if (holdingsValue <= 0) {
    return { var95_pct: null, var95_value: null, cvar95_pct: null, n_days: 0, total_value: total, scenarios: [], weights: [] };
  }

  const n = Math.min(...rows.map((r) => r.rets.length));
  const portRets: number[] = [];
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (const s of rows) r += (s.value / holdingsValue) * s.rets[s.rets.length - n + i];
    portRets.push(r);
  }
  portRets.sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(portRets.length * 0.05) - 1);
  const var95pct = portRets[idx];
  const tail = portRets.slice(0, idx + 1);
  const cvar95pct = tail.length ? tail.reduce((s, x) => s + x, 0) / tail.length : var95pct;
  const holdingsShare = holdingsValue / total; // cash isn't at risk in this VaR

  const scenarios = SCENARIOS.map((sc) => {
    let impact = 0;
    for (const s of rows) {
      const shock = (sc as unknown as Record<string, number>)[s.asset_class] ?? 0;
      impact += s.value * shock;
    }
    return {
      name: sc.name,
      impact_pct: total > 0 ? impact / total : 0,
      impact_value: impact,
      note: `applied per asset class`,
    };
  });

  return {
    var95_pct: var95pct * holdingsShare,
    var95_value: var95pct * holdingsValue,
    cvar95_pct: cvar95pct * holdingsShare,
    n_days: portRets.length,
    total_value: total,
    scenarios,
    weights: rows.map((r) => ({
      symbol: r.symbol,
      asset_class: r.asset_class,
      weight_pct: r.value / total,
    })),
  };
}

// Keep unused import guard happy without pulling logic
export type _CtsGuard = Cls;
