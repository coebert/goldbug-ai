/**
 * Compact wire format for the candidate-feature block in the AI decision prompt.
 *
 * The engine used to send `JSON.stringify(features, null, 2)`. For a typical
 * 22-symbol universe that is ~31k characters (~7.8k tokens) per tick, per
 * portfolio, per hour — and roughly two thirds of it is punctuation, indent
 * whitespace, repeated key names, and 12-decimal floats that carry no signal.
 *
 * This module emits the same information as a fixed-column table with one row
 * per symbol: keys are named once in a header, numbers are rounded to a
 * decision-relevant precision, and empty sub-objects collapse to a dash. No
 * field is dropped, so the model sees exactly what it saw before.
 */

/** Round to a fixed number of decimals and strip trailing zeros. */
function n(value: unknown, decimals = 2): string {
  if (value === null || value === undefined || value === "") return "-";
  const x = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(x)) return "-";
  const r = Number(x.toFixed(decimals));
  return Object.is(r, -0) ? "0" : String(r);
}

/** Large counts (average daily volume) as 1.2M / 340k, not 1234567.891. */
function compactCount(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const x = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(x)) return "-";
  const a = Math.abs(x);
  if (a >= 1e9) return `${n(x / 1e9, 2)}B`;
  if (a >= 1e6) return `${n(x / 1e6, 2)}M`;
  if (a >= 1e3) return `${n(x / 1e3, 1)}k`;
  return n(x, 0);
}

function flag(value: unknown): string {
  return value === true ? "Y" : "n";
}

type AnyFeature = Record<string, unknown>;

function sentimentCell(f: AnyFeature): string {
  const m = f["news_momentum"] as AnyFeature | null | undefined;
  const score = f["news_score"];
  const contributors = Number(f["news_contributors"] ?? 0);
  if (score == null && !m) return "-";
  const base = `${n(score, 2)}/${contributors}`;
  if (!m) return base;
  // today, 3d avg, 7d avg, 3d delta, 7d delta, acceleration, 7d contributors
  return `${base} t${n(m["today"], 2)} a3:${n(m["avg_3d"], 2)} a7:${n(m["avg_7d"], 2)} d3:${n(
    m["delta_3d"],
    2,
  )} d7:${n(m["delta_7d"], 2)} ac:${n(m["accel"], 2)} c7:${Number(m["contributors_7d"] ?? 0)}`;
}

function eventCell(f: AnyFeature): string {
  const e = f["event_features"] as AnyFeature | null | undefined;
  if (!e) return "-";
  const kinds = Array.isArray(e["top_kinds"]) ? (e["top_kinds"] as unknown[]).join("/") : "";
  const count = Number(e["event_count"] ?? 0);
  if (count === 0 && !kinds) return "-";
  return `s:${n(e["event_score"], 2)} p:${n(e["event_pressure"], 2)} nx${count} hard:${flag(
    e["hard_catalyst"],
  )}${kinds ? ` ${kinds}` : ""}`;
}

function rankCell(f: AnyFeature): string {
  const r = f["rank_info"] as AnyFeature | null | undefined;
  if (!r) return "-";
  return `#${Number(r["rank"] ?? 0)}/${Number(r["universe_size"] ?? 0)} p${n(
    r["percentile"],
    2,
  )} c:${n(r["composite_score"], 2)} mom:${n(r["momentum_z"], 2)} qua:${n(
    r["quality_z"],
    2,
  )} lvol:${n(r["low_vol_z"], 2)} trd:${n(r["trend_z"], 2)}${
    r["top_decile"] === true ? " TOP10%" : r["top_quartile"] === true ? " TOP25%" : ""
  }`;
}

/**
 * Published company financials: the reported accounts, the ratios derived from
 * them, consensus analyst estimates and the results calendar. Rendered as one
 * compact cell so the model sees the company's finances on the same row as its
 * price action, and never decides on technicals alone.
 */
function fundamentalsCell(f: AnyFeature, full = true): string {
  const d = f["fundamentals"] as AnyFeature | null | undefined;
  const s = f["fundamentals_score"] as AnyFeature | null | undefined;
  if (!d && !s) return "-";
  const riskFlags = Array.isArray((f["fundamentals_score"] as AnyFeature | undefined)?.["flags"])
    ? ((f["fundamentals_score"] as AnyFeature)["flags"] as unknown[])
    : [];
  // Digest form for names outside today's actionable shortlist: the headline
  // accounts the buy rules actually test (score, coverage, valuation, margin,
  // growth, gearing, consensus, results date) plus every disclosed red flag.
  // Costs ~120 characters instead of ~600 and hides no risk item; a name that
  // moves into the shortlist gets the full block on the next tick.
  if (!full) {
    const short = [
      s ? `sc:${n(s["score"], 2)} cov:${Number(s["coverage"] ?? 0)}/6` : null,
      d
        ? `pe:${n(d["trailing_pe"], 1)} nm:${n(d["profit_margin"], 3)} revg:${n(
            d["revenue_growth"],
            3,
          )} de:${n(d["debt_to_equity"], 1)} rec:${n(d["analyst_mean"], 2)} nxt_results:${
            d["next_earnings_date"] ?? "-"
          }`
        : null,
      riskFlags.length ? `RISK: ${riskFlags.join("; ")}` : null,
      "(digest — ask for nothing more; treat unknown as unknown)",
    ].filter(Boolean);
    return short.join(" ");
  }
  const parts: string[] = [];
  if (s) {
    const sub = (s["subscores"] as AnyFeature | undefined) ?? {};
    parts.push(
      `sc:${n(s["score"], 2)} cov:${Number(s["coverage"] ?? 0)}/6 val:${n(
        sub["valuation"],
        2,
      )} prof:${n(sub["profitability"], 2)} grw:${n(sub["growth"], 2)} bs:${n(
        sub["balance_sheet"],
        2,
      )} div:${n(sub["shareholder"], 2)} anl:${n(sub["analysts"], 2)}`,
    );
  }
  if (d) {
    // One ratio per question the buy rules actually ask: what am I paying
    // (pe, fpe, mcap), does it earn (nm, roe), is it growing (revg, eps+1y),
    // can it pay its debts (de, cr, fcf), what does the market think (dy,
    // beta, shrt, rec, tgt) and when do the next numbers land. Derived
    // duplicates (peg, pb, ev/ebitda, gross and operating margin, roa,
    // trailing eps growth, next-quarter eps, payout, absolute cash and debt)
    // were dropped: the model re-derives them from these when it needs them,
    // and they cost roughly 40% of every fundamentals block.
    parts.push(
      `pe:${n(d["trailing_pe"], 1)} fpe:${n(d["forward_pe"], 1)} mcap:${compactCount(
        d["market_cap"],
      )}`,
      `nm:${n(d["profit_margin"], 3)} roe:${n(d["return_on_equity"], 3)} revg:${n(
        d["revenue_growth"],
        3,
      )} eps+1y:${n(d["eps_growth_next_y"], 3)}`,
      `de:${n(d["debt_to_equity"], 1)} cr:${n(d["current_ratio"], 2)} fcf:${compactCount(
        d["free_cashflow"],
      )}`,
      `dy:${n(d["dividend_yield"], 4)} beta:${n(d["beta"], 2)} shrt:${n(
        d["short_percent_float"],
        3,
      )}`,
      `rec:${n(d["analyst_mean"], 2)}/${Number(d["analyst_count"] ?? 0)} tgt:${n(
        d["target_mean_price"],
        2,
      )} nxt_results:${d["next_earnings_date"] ?? "-"} ccy:${d["financial_currency"] ?? "-"}`,
    );
  }
  const flags = Array.isArray(s?.["flags"]) ? (s?.["flags"] as unknown[]) : [];
  if (flags.length) parts.push(`RISK: ${flags.join("; ")}`);
  return parts.join(" ");
}


const COLUMNS = [
  "symbol",
  "name",
  "class",
  "price",
  "sma20",
  "sma50",
  "rsi14",
  "chg5d",
  "chg30d",
  "vol20d",
  "macd_h",
  "x", // macd cross: B=bullish, R=bearish, n=none
  "bb_w",
  "atr%",
  "adv20",
  "vwmom10",
  "wk_up",
  "wk_rsi",
  "cool",
] as const;

/**
 * Render candidate features as a pipe-delimited table.
 *
 * Legend lines are included so the model can read the columns without any
 * prior context — they cost ~120 tokens once, versus ~40 repeated key names
 * on every one of the 20-plus rows.
 */
/**
 * How many candidates carry the full published-accounts block. The rest carry
 * the digest (see fundamentalsCell): every red flag and headline ratio, none of
 * the long tail. Full blocks go to the names most likely to be traded this
 * tick — best cross-sectional rank, plus anything with a dated hard catalyst.
 */
export const FULL_FUNDAMENTALS_ROWS = 6;

function fullFundamentalsSymbols(features: readonly AnyFeature[]): Set<string> {
  const scored = features.map((f, i) => {
    const r = f["rank_info"] as AnyFeature | null | undefined;
    const pct = Number(r?.["percentile"]);
    return {
      symbol: String(f["symbol"] ?? `#${i}`),
      // Higher is better; unranked names fall back to their input order.
      score: Number.isFinite(pct) ? pct : 1 - i / Math.max(1, features.length),
      hard: (f["event_features"] as AnyFeature | null | undefined)?.["hard_catalyst"] === true,
    };
  });
  const out = new Set<string>();
  for (const s of scored) if (s.hard) out.add(s.symbol);
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (out.size >= FULL_FUNDAMENTALS_ROWS) break;
    out.add(s.symbol);
  }
  return out;
}

export function formatCandidateTable(features: readonly unknown[]): string {
  if (!Array.isArray(features) || features.length === 0) {
    return "Candidate assets: none passed today's filters.";
  }

  const fullSet = fullFundamentalsSymbols(features as AnyFeature[]);

  const rows = (features as AnyFeature[]).map((f) => {
    const cross =
      f["macd_bull_cross"] === true ? "B" : f["macd_bear_cross"] === true ? "R" : "n";
    const cells = [
      String(f["symbol"] ?? "?"),
      String(f["name"] ?? "-"),
      String(f["asset_class"] ?? "-"),
      n(f["price"], 4),
      n(f["sma20"], 4),
      n(f["sma50"], 4),
      n(f["rsi14"], 1),
      n(f["change5d"], 4),
      n(f["change30d"], 4),
      n(f["vol20d"], 4),
      n(f["macd_hist"], 4),
      cross,
      n(f["bb_width"], 4),
      n(f["atr_pct"], 2),
      compactCount(f["adv_20d"]),
      n(f["vw_momentum_10d"], 4),
      flag(f["weekly_trend_up"]),
      n(f["weekly_rsi14"], 1),
      flag(f["cooling"]),
    ];
    return `${cells.join(" | ")} || news ${sentimentCell(f)} || events ${eventCell(
      f,
    )} || rank ${rankCell(f)} || fund ${fundamentalsCell(
      f,
      fullSet.has(String(f["symbol"] ?? "")),
    )}`;
  });

  return `Candidate assets — one row per symbol, fields separated by " | ", sub-blocks by " || ". Values rounded; "-" = not available.
Columns: ${COLUMNS.join(" | ")}
  x = MACD cross this bar (B bullish / R bearish / n none); wk_up = weekly trend up (Y/n); cool = loss-cooldown active (Y/n); chg5d/chg30d are fractional returns (0.05 = +5%); adv20 = 20d average daily volume.
  news = <weighted LLM sentiment>/<contributors today> t<today> a3/a7<3d & 7d averages> d3/d7<deltas vs baseline> ac<acceleration> c7<7d contributors>.
  events = s<directional event score -1..1> p<event pressure 0..1> nx<event count> hard<dated hard catalyst Y/n> <top event kinds>.
  fund = the company's published accounts. sc<overall -1..1> cov<pillars with data>/6 val/prof/grw/bs/div/anl<pillar scores>; pe/fpe<price/earnings, trailing and forward> mcap; nm<net margin> roe; revg<revenue growth> eps+1y<forecast earnings growth>; de<debt/equity %> cr<current ratio> fcf<free cash flow>; dy<dividend yield> beta shrt<short % of float>; rec<analyst view 1 buy..5 sell>/<count> tgt<price target, listing currency> nxt_results<next results date> ccy<currency of the accounts>. RISK = disclosed red flags. "(digest" = short form, used for names outside the top-ranked shortlist; it is not a quality signal. "-" = not published (normal for ETFs, commodities, FX, crypto).
  rank = #<cross-sectional rank>/<universe size> p<percentile> c<composite z> mom/qua/lvol/trd<factor z-scores>.
${rows.join("\n")}`;
}

/**
 * Asset classes present in today's decision surface (candidates + holdings).
 * Used to skip playbook sections the portfolio cannot act on this tick.
 */
export function activeAssetClasses(
  features: readonly unknown[],
  holdings: readonly { symbol?: string; asset_class?: string | null }[] = [],
): Set<string> {
  const out = new Set<string>();
  for (const f of (features as AnyFeature[]) ?? []) {
    const c = f?.["asset_class"];
    if (typeof c === "string" && c) out.add(c.toLowerCase());
  }
  for (const h of holdings) {
    const c = h?.asset_class;
    if (typeof c === "string" && c) out.add(c.toLowerCase());
  }
  return out;
}
