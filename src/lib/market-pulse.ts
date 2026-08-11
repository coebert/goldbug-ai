// Pure computation behind the home-screen "Market pulse" dashboard.
//
// Takes raw daily closes out of `price_cache` and turns them into the handful
// of numbers a trader scans first: how each asset class moved over 1 day /
// 5 days / 1 month, how wide the participation is (breadth), where volatility
// sits, and one overall risk tone.
//
// Percentage moves are unit-agnostic (close ÷ close), so GBX-quoted LSE
// symbols need no scaling here.

export interface PriceRow {
  symbol: string;
  price_date: string;
  close: number;
}

export interface PulseInstrument {
  symbol: string;
  label: string;
  group: PulseGroup;
  /** Rising price = risk appetite (false for VIX, gold, inverse ETFs). */
  riskOn?: boolean;
}

export type PulseGroup = "equities" | "rates" | "commodities" | "fx" | "crypto" | "volatility";

export interface PulseQuote {
  symbol: string;
  label: string;
  group: PulseGroup;
  close: number;
  asOf: string;
  changePct1d: number | null;
  changePct5d: number | null;
  changePct1m: number | null;
  changePct3m: number | null;
  /** Distance from the 50-day average, in %. Positive = trading above trend. */
  vsSma50Pct: number | null;
  aboveSma50: boolean | null;
  spark: Array<{ date: string; value: number }>;
}

export interface SectorQuote extends PulseQuote {}

export interface BreadthSummary {
  total: number;
  advancers: number;
  decliners: number;
  aboveSma50: number;
  aboveSma50Pct: number | null;
  advancersPct: number | null;
}

export type RiskTone = "risk_on" | "neutral" | "risk_off";

export interface MarketPulse {
  asOf: string | null;
  tone: RiskTone;
  toneScore: number; // 0 (max fear) … 100 (max greed)
  toneReasons: string[];
  quotes: PulseQuote[];
  sectors: SectorQuote[];
  breadth: BreadthSummary;
  /** Normalised (=100 at window start) comparison lines. */
  comparison: {
    days: number;
    series: Array<{ date: string; [symbol: string]: number | string }>;
    keys: Array<{ symbol: string; label: string }>;
  };
}

/** Headline instruments, in scan order. */
export const PULSE_INSTRUMENTS: PulseInstrument[] = [
  { symbol: "SPY", label: "US large cap (S&P 500)", group: "equities", riskOn: true },
  { symbol: "QQQ", label: "US tech (Nasdaq 100)", group: "equities", riskOn: true },
  { symbol: "ISF.L", label: "UK large cap (FTSE 100)", group: "equities", riskOn: true },
  { symbol: "VMID.L", label: "UK mid cap (FTSE 250)", group: "equities", riskOn: true },
  { symbol: "EFA", label: "Developed ex-US", group: "equities", riskOn: true },
  { symbol: "EEM", label: "Emerging markets", group: "equities", riskOn: true },
  { symbol: "^VIX", label: "Volatility (VIX)", group: "volatility", riskOn: false },
  { symbol: "TLT", label: "Long US treasuries", group: "rates", riskOn: false },
  { symbol: "HYG", label: "High-yield credit", group: "rates", riskOn: true },
  { symbol: "AGG", label: "US aggregate bonds", group: "rates", riskOn: false },
  { symbol: "GLD", label: "Gold", group: "commodities", riskOn: false },
  { symbol: "SLV", label: "Silver", group: "commodities" },
  { symbol: "USO", label: "Crude oil", group: "commodities" },
  { symbol: "COPA.L", label: "Copper", group: "commodities", riskOn: true },
  { symbol: "GBPUSD=X", label: "GBP / USD", group: "fx" },
  { symbol: "EURUSD=X", label: "EUR / USD", group: "fx" },
  { symbol: "DX-Y.NYB", label: "US dollar index", group: "fx", riskOn: false },
  { symbol: "BTC-USD", label: "Bitcoin", group: "crypto", riskOn: true },
  { symbol: "ETH-USD", label: "Ethereum", group: "crypto", riskOn: true },
];

/** US sector ETFs — the fastest read on what is leading and lagging. */
export const PULSE_SECTORS: Array<{ symbol: string; label: string }> = [
  { symbol: "XLK", label: "Technology" },
  { symbol: "XLC", label: "Communications" },
  { symbol: "XLY", label: "Consumer discretionary" },
  { symbol: "XLF", label: "Financials" },
  { symbol: "XLI", label: "Industrials" },
  { symbol: "XLE", label: "Energy" },
  { symbol: "XLB", label: "Materials" },
  { symbol: "XLV", label: "Health care" },
  { symbol: "XLP", label: "Consumer staples" },
  { symbol: "XLU", label: "Utilities" },
  { symbol: "XLRE", label: "Real estate" },
];

/** Lines drawn on the comparison chart (normalised to 100). */
export const PULSE_COMPARISON: Array<{ symbol: string; label: string }> = [
  { symbol: "SPY", label: "S&P 500" },
  { symbol: "ISF.L", label: "FTSE 100" },
  { symbol: "GLD", label: "Gold" },
  { symbol: "BTC-USD", label: "Bitcoin" },
];

export const PULSE_SYMBOLS: string[] = [
  ...new Set([
    ...PULSE_INSTRUMENTS.map((i) => i.symbol),
    ...PULSE_SECTORS.map((s) => s.symbol),
    ...PULSE_COMPARISON.map((s) => s.symbol),
  ]),
];

const GROUP_LABELS: Record<PulseGroup, string> = {
  equities: "Shares",
  rates: "Bonds & credit",
  commodities: "Commodities",
  fx: "Currencies",
  crypto: "Crypto",
  volatility: "Volatility",
};

export function groupLabel(group: PulseGroup): string {
  return GROUP_LABELS[group];
}

/** Group rows by symbol, sorted oldest → newest, invalid closes dropped. */
export function bySymbol(rows: PriceRow[]): Map<string, PriceRow[]> {
  const map = new Map<string, PriceRow[]>();
  for (const r of rows) {
    if (!r || typeof r.close !== "number" || !Number.isFinite(r.close) || r.close <= 0) continue;
    const list = map.get(r.symbol);
    if (list) list.push(r);
    else map.set(r.symbol, [r]);
  }
  for (const list of map.values()) list.sort((a, b) => a.price_date.localeCompare(b.price_date));
  return map;
}

function pctChangeBack(series: PriceRow[], sessionsBack: number): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const idx = series.length - 1 - sessionsBack;
  const prev = series[idx >= 0 ? idx : 0];
  if (!prev || prev.close <= 0 || prev === last) return null;
  return ((last.close - prev.close) / prev.close) * 100;
}

function sma(series: PriceRow[], window: number): number | null {
  if (series.length < Math.min(window, 10)) return null;
  const slice = series.slice(-window);
  const sum = slice.reduce((acc, r) => acc + r.close, 0);
  return sum / slice.length;
}

export function buildQuote(
  meta: { symbol: string; label: string; group: PulseGroup },
  series: PriceRow[],
  sparkDays = 60,
): PulseQuote | null {
  if (!series.length) return null;
  const last = series[series.length - 1];
  const avg50 = sma(series, 50);
  return {
    symbol: meta.symbol,
    label: meta.label,
    group: meta.group,
    close: last.close,
    asOf: last.price_date,
    changePct1d: pctChangeBack(series, 1),
    changePct5d: pctChangeBack(series, 5),
    changePct1m: pctChangeBack(series, 21),
    changePct3m: pctChangeBack(series, 63),
    vsSma50Pct: avg50 && avg50 > 0 ? ((last.close - avg50) / avg50) * 100 : null,
    aboveSma50: avg50 ? last.close > avg50 : null,
    spark: series.slice(-sparkDays).map((r) => ({ date: r.price_date, value: r.close })),
  };
}

export function computeBreadth(quotes: PulseQuote[]): BreadthSummary {
  const scored = quotes.filter((q) => q.changePct1d != null);
  const advancers = scored.filter((q) => (q.changePct1d ?? 0) > 0).length;
  const decliners = scored.filter((q) => (q.changePct1d ?? 0) < 0).length;
  const trendable = quotes.filter((q) => q.aboveSma50 != null);
  const aboveSma50 = trendable.filter((q) => q.aboveSma50).length;
  return {
    total: quotes.length,
    advancers,
    decliners,
    aboveSma50,
    aboveSma50Pct: trendable.length ? (aboveSma50 / trendable.length) * 100 : null,
    advancersPct: scored.length ? (advancers / scored.length) * 100 : null,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * One 0–100 risk-appetite score from four independent reads: breadth,
 * equity trend, volatility level and the credit/defensive tilt. Each
 * contributes 25 points so no single input can flip the tone alone.
 */
export function computeTone(
  quotes: PulseQuote[],
  sectors: PulseQuote[],
  breadth: BreadthSummary,
): { tone: RiskTone; score: number; reasons: string[] } {
  const find = (s: string) => quotes.find((q) => q.symbol === s) ?? sectors.find((q) => q.symbol === s);
  const reasons: string[] = [];
  let score = 0;
  let weight = 0;

  const breadthPct = breadth.aboveSma50Pct;
  if (breadthPct != null) {
    score += (breadthPct / 100) * 25;
    weight += 25;
    reasons.push(
      breadthPct >= 60
        ? `${Math.round(breadthPct)}% of tracked markets are above their 50-day average — broad participation`
        : breadthPct <= 40
          ? `Only ${Math.round(breadthPct)}% of tracked markets are above their 50-day average — narrow, weak participation`
          : `${Math.round(breadthPct)}% of markets above their 50-day average — mixed participation`,
    );
  }

  const spy = find("SPY");
  if (spy?.vsSma50Pct != null) {
    score += clamp((spy.vsSma50Pct + 5) / 10, 0, 1) * 25;
    weight += 25;
    reasons.push(
      spy.vsSma50Pct >= 0
        ? `S&P 500 is ${spy.vsSma50Pct.toFixed(1)}% above its 50-day average — uptrend intact`
        : `S&P 500 is ${Math.abs(spy.vsSma50Pct).toFixed(1)}% below its 50-day average — trend broken`,
    );
  }

  const vix = find("^VIX");
  if (vix) {
    // 12 = calm (full marks), 32 = stressed (zero).
    score += clamp((32 - vix.close) / 20, 0, 1) * 25;
    weight += 25;
    reasons.push(
      vix.close <= 16
        ? `Volatility (VIX) at ${vix.close.toFixed(1)} — calm conditions`
        : vix.close >= 25
          ? `Volatility (VIX) at ${vix.close.toFixed(1)} — stressed conditions`
          : `Volatility (VIX) at ${vix.close.toFixed(1)} — ordinary conditions`,
    );
  }

  // Defensive tilt: staples + utilities beating discretionary + tech over a month.
  const avg = (syms: string[]) => {
    const vals = syms.map((s) => find(s)?.changePct1m).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const defensive = avg(["XLP", "XLU"]);
  const cyclical = avg(["XLY", "XLK"]);
  if (defensive != null && cyclical != null) {
    const spread = cyclical - defensive; // positive = cyclicals leading = risk-on
    score += clamp((spread + 4) / 8, 0, 1) * 25;
    weight += 25;
    reasons.push(
      spread >= 0
        ? `Cyclical sectors are leading defensives by ${spread.toFixed(1)} points over a month`
        : `Defensive sectors are leading cyclicals by ${Math.abs(spread).toFixed(1)} points over a month`,
    );
  }

  const normalised = weight > 0 ? (score / weight) * 100 : 50;
  const tone: RiskTone = normalised >= 60 ? "risk_on" : normalised <= 40 ? "risk_off" : "neutral";
  return { tone, score: Math.round(normalised), reasons };
}

export function toneLabel(tone: RiskTone): string {
  return tone === "risk_on" ? "Risk-on" : tone === "risk_off" ? "Risk-off" : "Mixed";
}

export function toneBlurb(tone: RiskTone): string {
  return tone === "risk_on"
    ? "Markets are broadly rising and calm — conditions favour taking positions."
    : tone === "risk_off"
      ? "Markets are falling or unsettled — conditions favour caution and smaller positions."
      : "No clear direction — some markets rising, others falling.";
}

/** Normalise the comparison symbols to 100 at the start of the window. */
export function buildComparison(
  map: Map<string, PriceRow[]>,
  days: number,
): MarketPulse["comparison"] {
  const keys: Array<{ symbol: string; label: string }> = [];
  const perSymbol = new Map<string, Map<string, number>>();
  const dates = new Set<string>();

  for (const c of PULSE_COMPARISON) {
    const series = (map.get(c.symbol) ?? []).slice(-days);
    if (series.length < 2) continue;
    const base = series[0].close;
    if (!(base > 0)) continue;
    keys.push(c);
    const points = new Map<string, number>();
    for (const r of series) {
      points.set(r.price_date, (r.close / base) * 100);
      dates.add(r.price_date);
    }
    perSymbol.set(c.symbol, points);
  }

  const sortedDates = [...dates].sort();
  const last: Record<string, number> = {};
  const series = sortedDates.map((date) => {
    const point: { date: string; [k: string]: number | string } = { date };
    for (const k of keys) {
      const v = perSymbol.get(k.symbol)?.get(date);
      if (v != null) last[k.symbol] = v;
      // Carry the previous value forward so mismatched trading calendars
      // (LSE holidays vs NYSE) do not tear the lines apart.
      if (last[k.symbol] != null) point[k.symbol] = Number(last[k.symbol].toFixed(2));
    }
    return point;
  });

  return { days, series, keys };
}

export function computeMarketPulse(rows: PriceRow[], comparisonDays = 90): MarketPulse {
  const map = bySymbol(rows);
  const quotes = PULSE_INSTRUMENTS.map((i) => buildQuote(i, map.get(i.symbol) ?? [])).filter(
    (q): q is PulseQuote => q != null,
  );
  const sectors = PULSE_SECTORS.map((s) =>
    buildQuote({ ...s, group: "equities" }, map.get(s.symbol) ?? []),
  ).filter((q): q is PulseQuote => q != null);

  // Volatility is a fear gauge, not a market to participate in — exclude it
  // from breadth so a VIX spike never counts as an "advancer".
  const breadthUniverse = [...quotes.filter((q) => q.group !== "volatility"), ...sectors];
  const breadth = computeBreadth(breadthUniverse);
  const { tone, score, reasons } = computeTone(quotes, sectors, breadth);

  const asOf =
    [...quotes, ...sectors].map((q) => q.asOf).sort().slice(-1)[0] ?? null;

  return {
    asOf,
    tone,
    toneScore: score,
    toneReasons: reasons,
    quotes,
    sectors,
    breadth,
    comparison: buildComparison(map, comparisonDays),
  };
}
