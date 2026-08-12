// Deterministic "chart brief": everything visible on the SMA + RSI charts,
// reduced to a compact structure the AI can interpret.
//
// Detection stays deterministic so the same chart always yields the same
// facts; the AI layer only reads those facts back in plain English. A gateway
// outage degrades to `fallbackRead`, never to an empty panel.

import {
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  SMA_PERIODS,
  crossoverLabel,
  detectSmaCrossovers,
  rsiZone,
  smaKey,
  type HistoryPoint,
  type SmaCrossover,
  type SmaPeriod,
  type SymbolHistory,
  type TrendStrength,
} from "./market-symbol-history";
import { detectRsiDivergences, divergenceSummary, type RsiDivergence } from "./rsi-divergence";
import { detectRsiSignals, rsiSignalSummary, type RsiSignal, type RsiSignalMode } from "./rsi-signals";

export interface SmaReadLine {
  period: SmaPeriod;
  value: number | null;
  above: boolean | null;
  /** Distance of the last close from the average, in %. */
  distancePct: number | null;
  /** "rising" | "falling" | "flat" over the last 10 bars, null when unknown. */
  slope: "rising" | "falling" | "flat" | null;
}

export interface TechnicalBrief {
  symbol: string;
  label: string;
  days: number;
  asOf: string | null;
  last: number | null;
  changePct: number | null;
  volatilityPct: number | null;
  maxDrawdownPct: number | null;
  smas: SmaReadLine[];
  /** True when the selected averages are stacked fast>slow (or slow>fast). */
  stack: "bullish" | "bearish" | "mixed";
  crossovers: SmaCrossover[];
  trend: TrendStrength | null;
  rsi: number | null;
  rsiZone: "oversold" | "overbought" | "neutral" | null;
  /** RSI change over the last 5 readable bars, in points. */
  rsiChange5: number | null;
  divergences: RsiDivergence[];
  signalMode: RsiSignalMode;
  signals: RsiSignal[];
}

export interface TechnicalRead {
  /** Plain-English interpretation of the chart. */
  read: string;
  /** Short bullets: what would confirm / invalidate the read. */
  watch: string[];
  /** Model id when AI wrote the text, null for the deterministic fallback. */
  model: string | null;
  brief: TechnicalBrief;
}

function slopeOf(points: HistoryPoint[], period: SmaPeriod): SmaReadLine["slope"] {
  const key = smaKey(period);
  const last = points[points.length - 1]?.[key];
  const prev = points[points.length - 11]?.[key];
  if (last == null || prev == null || prev <= 0) return null;
  const pct = ((last - prev) / prev) * 100;
  if (pct > 0.25) return "rising";
  if (pct < -0.25) return "falling";
  return "flat";
}

export function buildTechnicalBrief(
  history: SymbolHistory,
  periods: readonly SmaPeriod[],
  trend: TrendStrength | null,
  signalMode: RsiSignalMode,
): TechnicalBrief {
  const points = history.points;
  const ordered = SMA_PERIODS.filter((p) => periods.includes(p));
  const last = history.last;

  const smas: SmaReadLine[] = ordered.map((period) => {
    const value = history.smaLatest[period] ?? null;
    return {
      period,
      value,
      above: history.aboveSma[period] ?? null,
      distancePct: value != null && value > 0 && last != null ? ((last - value) / value) * 100 : null,
      slope: slopeOf(points, period),
    };
  });

  const values = smas.map((s) => s.value);
  const usable = values.every((v) => v != null) && values.length >= 2;
  let stack: TechnicalBrief["stack"] = "mixed";
  if (usable) {
    const nums = values as number[];
    if (nums.every((v, i) => i === 0 || nums[i - 1] > v)) stack = "bullish";
    else if (nums.every((v, i) => i === 0 || nums[i - 1] < v)) stack = "bearish";
  }

  const rsiSeries = points.map((p) => p.rsi14).filter((v): v is number => typeof v === "number");
  const rsiChange5 =
    rsiSeries.length >= 6
      ? rsiSeries[rsiSeries.length - 1] - rsiSeries[rsiSeries.length - 6]
      : null;

  return {
    symbol: history.symbol,
    label: history.label,
    days: history.days,
    asOf: history.asOf,
    last,
    changePct: history.changePct,
    volatilityPct: history.volatilityPct,
    maxDrawdownPct: history.maxDrawdownPct,
    smas,
    stack,
    crossovers: detectSmaCrossovers(points, ordered).slice(0, 4),
    trend,
    rsi: history.rsi14,
    rsiZone: rsiZone(history.rsi14),
    rsiChange5,
    divergences: detectRsiDivergences(points).slice(-4),
    signalMode,
    signals: detectRsiSignals(points, signalMode).slice(-4),
  };
}

function pct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** Compact, model-readable rendering of everything drawn on the charts. */
export function briefToText(b: TechnicalBrief): string {
  const lines: string[] = [];
  lines.push(
    `${b.label} (${b.symbol}) — ${b.days}d window to ${b.asOf ?? "n/a"}; window change ${pct(b.changePct)}, annualised vol ${pct(b.volatilityPct, 0)}, max drawdown ${pct(b.maxDrawdownPct)}.`,
  );
  lines.push("Moving averages (last close vs average):");
  for (const s of b.smas) {
    lines.push(
      `- SMA${s.period}: ${s.value == null ? "not warm" : s.value.toFixed(2)}, price ${s.above == null ? "n/a" : s.above ? "above" : "below"} by ${pct(s.distancePct)}, average ${s.slope ?? "unknown"}.`,
    );
  }
  lines.push(`Average stack: ${b.stack}.`);
  if (b.trend) {
    lines.push(
      `Trend strength (SMA${b.trend.period} basis): ${b.trend.label}, score ${b.trend.score}/100, slope ${pct(b.trend.slopeAnnualPct, 0)} annualised.`,
    );
  }
  if (b.crossovers.length) {
    lines.push("Crossovers in window (newest first):");
    for (const c of b.crossovers) {
      lines.push(
        `- ${c.date}: ${crossoverLabel(c)} (${c.direction}), ${c.barsAgo} bars ago, price since ${pct(c.sinceChangePct)}.`,
      );
    }
  } else {
    lines.push("No moving-average crossovers inside the window.");
  }
  lines.push(
    `RSI(14): ${b.rsi == null ? "not warm" : b.rsi.toFixed(1)} (${b.rsiZone ?? "n/a"}; oversold ${RSI_OVERSOLD}, overbought ${RSI_OVERBOUGHT}), 5-bar change ${b.rsiChange5 == null ? "n/a" : `${b.rsiChange5 >= 0 ? "+" : ""}${b.rsiChange5.toFixed(1)} pts`}.`,
  );
  if (b.divergences.length) {
    lines.push("RSI divergences (oldest first):");
    for (const d of b.divergences) {
      lines.push(`- ${d.from.date} -> ${d.to.date} (${d.bars} bars): ${divergenceSummary(d)}.`);
    }
  } else {
    lines.push("No RSI divergences detected in the window.");
  }
  if (b.signals.length) {
    lines.push(`RSI zone markers (${b.signalMode} mode):`);
    for (const s of b.signals) {
      lines.push(`- ${s.date}: ${s.kind.toUpperCase()} — ${rsiSignalSummary(s)}.`);
    }
  } else {
    lines.push(`No RSI zone markers in ${b.signalMode} mode.`);
  }
  return lines.join("\n");
}

export function buildTechnicalReadPrompt(b: TechnicalBrief): string {
  return [
    "You are a disciplined technical analyst reviewing a price chart with moving-average overlays and an RSI pane.",
    "Interpret ONLY the facts below — never invent prices, dates, news or indicators that are not listed.",
    "",
    briefToText(b),
    "",
    "Reply as strict JSON with this shape and nothing else:",
    '{"read": "3-5 sentences of plain English: trend from the moving averages, momentum from RSI, whether they agree or disagree, and what the divergences/markers imply", "watch": ["2-4 short bullets naming the specific level or condition that would confirm the read, and the one that would invalidate it"]}',
    "Be concrete about levels (use the average values and RSI thresholds given). Say plainly when the evidence is weak or mixed. Do not give financial advice or a buy/sell instruction.",
  ].join("\n");
}

export function parseTechnicalReadReply(text: string): { read: string; watch: string[] } | null {
  const raw = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      read?: unknown;
      watch?: unknown;
    };
    const read = typeof parsed.read === "string" ? parsed.read.trim() : "";
    if (!read) return null;
    const watch = Array.isArray(parsed.watch)
      ? parsed.watch.filter((w): w is string => typeof w === "string" && w.trim().length > 0).slice(0, 5)
      : [];
    return { read, watch: watch.map((w) => w.trim()) };
  } catch {
    return null;
  }
}

/** Deterministic interpretation, used whenever the AI layer is unavailable. */
export function fallbackRead(b: TechnicalBrief): { read: string; watch: string[] } {
  const parts: string[] = [];
  const trendWord =
    b.stack === "bullish" ? "stacked bullishly" : b.stack === "bearish" ? "stacked bearishly" : "mixed";
  parts.push(
    `Over the last ${b.days} days ${b.label} is ${pct(b.changePct)} with the selected averages ${trendWord}.`,
  );
  const slow = b.smas[b.smas.length - 1];
  if (slow && slow.above != null) {
    parts.push(
      `Price sits ${slow.above ? "above" : "below"} the SMA${slow.period} by ${pct(slow.distancePct)} and that average is ${slow.slope ?? "of unclear direction"}.`,
    );
  }
  const cross = b.crossovers[0];
  if (cross) {
    parts.push(
      `Most recent crossover: ${crossoverLabel(cross)} on ${cross.date} (${cross.barsAgo} bars ago), price ${pct(cross.sinceChangePct)} since.`,
    );
  }
  if (b.rsi != null) {
    parts.push(
      `RSI(14) is ${b.rsi.toFixed(1)} (${b.rsiZone ?? "neutral"}), ${b.rsiChange5 == null ? "with no 5-bar comparison" : `${b.rsiChange5 >= 0 ? "up" : "down"} ${Math.abs(b.rsiChange5).toFixed(1)} points over 5 bars`}.`,
    );
  }
  const div = b.divergences[b.divergences.length - 1];
  if (div) {
    parts.push(
      `Latest divergence is ${div.kind} between ${div.from.date} and ${div.to.date}: ${divergenceSummary(div)}.`,
    );
  } else {
    parts.push("No RSI divergence is present, so momentum is not contradicting price.");
  }

  const watch: string[] = [];
  if (slow?.value != null) {
    watch.push(
      `${slow.above ? "Holding" : "Reclaiming"} SMA${slow.period} at ${slow.value.toFixed(2)} keeps the ${slow.above ? "trend intact" : "recovery alive"}.`,
    );
  }
  watch.push(`RSI back above ${RSI_OVERSOLD} or below ${RSI_OVERBOUGHT} marks the next zone signal.`);
  if (div) {
    watch.push(
      div.kind === "bullish"
        ? `Bullish divergence fails if price closes below ${div.to.price.toFixed(2)}.`
        : `Bearish divergence fails if price closes above ${div.to.price.toFixed(2)}.`,
    );
  }
  return { read: parts.join(" "), watch };
}
