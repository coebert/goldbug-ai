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
  const x = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(x)) return "-";
  const r = Number(x.toFixed(decimals));
  return Object.is(r, -0) ? "0" : String(r);
}

/** Large counts (average daily volume) as 1.2M / 340k, not 1234567.891. */
function compactCount(value: unknown): string {
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

const COLUMNS = [
  "symbol",
  "name",
  "class",
  "price",
  "sma20",
  "sma50",
  "rsi14",
  "chg5d%",
  "chg30d%",
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
export function formatCandidateTable(features: readonly unknown[]): string {
  if (!Array.isArray(features) || features.length === 0) {
    return "Candidate assets: none passed today's filters.";
  }

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
      n(f["change5d"], 2),
      n(f["change30d"], 2),
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
    )} || rank ${rankCell(f)}`;
  });

  return `Candidate assets — one row per symbol, fields separated by " | ", sub-blocks by " || ". Values rounded; "-" = not available.
Columns: ${COLUMNS.join(" | ")}
  x = MACD cross this bar (B bullish / R bearish / n none); wk_up = weekly trend up (Y/n); cool = loss-cooldown active (Y/n); adv20 = 20d average daily volume.
  news = <weighted LLM sentiment>/<contributors today> t<today> a3/a7<3d & 7d averages> d3/d7<deltas vs baseline> ac<acceleration> c7<7d contributors>.
  events = s<directional event score -1..1> p<event pressure 0..1> nx<event count> hard<dated hard catalyst Y/n> <top event kinds>.
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
