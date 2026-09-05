/**
 * Evidence brief: this account's own trading history, written out as prose an
 * AI can reason over.
 *
 * The ridge fit answered "what linear combination of signals predicted the
 * next five days?" and, on this book's short history, answered it weakly. The
 * brief answers a different and more useful question: given every decision
 * this account has recorded, WHAT ACTUALLY HAPPENED after each kind of setup,
 * on this book, net of the costs it actually paid.
 *
 * It is deterministic — no model, no fit, no p-hacking. It buckets the same
 * feature snapshots the engine handed the AI on each past day, joins them to
 * the realised cost- and risk-adjusted forward outcome, and reports the table.
 * The AI is then asked to turn that table into a playbook (playbook.server.ts).
 */

import { FEATURE_SPECS, labelOf } from "./features";
import { buildDataset } from "./dataset.server";
import type { Sample } from "./fit";

export type QuantileCell = {
  /** 1 = lowest fifth of the feature that day, 5 = highest. */
  bucket: number;
  n: number;
  /** Mean realised outcome, in basis points, relative to that day's average. */
  meanBps: number;
  /** Share of observations with a positive relative outcome. */
  hitPct: number;
};

export type FeatureEvidence = {
  key: string;
  label: string;
  group: string;
  cells: QuantileCell[];
  /** Top fifth minus bottom fifth, in bps. Positive = higher is better. */
  spreadBps: number;
  /** Rough significance of that spread (t-like), for honesty about noise. */
  tStat: number;
};

export type SymbolRecord = {
  symbol: string;
  n: number;
  meanBps: number;
  hitPct: number;
};

export type HistoryBrief = {
  coverage: {
    samples: number;
    dates: number;
    symbols: number;
    from: string | null;
    to: string | null;
    horizonDays: number;
    tradedSamples: number;
    heldSamples: number;
    roundTripCostBps: number;
  };
  features: FeatureEvidence[];
  bestSymbols: SymbolRecord[];
  worstSymbols: SymbolRecord[];
  /** The whole thing rendered as text, ready to hand to the model. */
  text: string;
};

const QUANTILES = 5;

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function sd(v: number[], m: number): number {
  if (v.length < 2) return 0;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1));
}

/**
 * Demean each day's labels and rank each day's feature values, so a cell says
 * "names in the top fifth of this signal that day beat the day's average by
 * X bps" rather than mixing good and bad markets together.
 */
function evidenceFor(samples: Sample[], featureIndex: number): FeatureEvidence | null {
  const byDate = new Map<string, Sample[]>();
  for (const s of samples) {
    const arr = byDate.get(s.date);
    if (arr) arr.push(s);
    else byDate.set(s.date, [s]);
  }

  const cells: Array<{ ys: number[] }> = Array.from({ length: QUANTILES }, () => ({ ys: [] }));
  let daysWithSpread = 0;
  let daysSeen = 0;

  for (const rows of byDate.values()) {
    const usable = rows.filter((r) => {
      const x = r.x[featureIndex];
      return x !== null && Number.isFinite(x) && Number.isFinite(r.y);
    });
    if (usable.length < QUANTILES) continue;
    daysSeen++;
    // Book-level features (cash share, drawdown) are identical for every
    // candidate on a day. Ranking ties would hand the quintiles out by list
    // order and manufacture an edge out of nothing, so those days are skipped
    // and a feature that is flat on most days is dropped entirely below.
    const distinct = new Set(usable.map((r) => r.x[featureIndex] as number));
    if (distinct.size < QUANTILES) continue;
    daysWithSpread++;
    const dayMean = mean(usable.map((r) => r.y));
    const ordered = [...usable].sort((a, b) => (a.x[featureIndex] as number) - (b.x[featureIndex] as number));
    ordered.forEach((r, i) => {
      const q = Math.min(QUANTILES - 1, Math.floor((i / ordered.length) * QUANTILES));
      cells[q]!.ys.push((r.y - dayMean) * 10_000);
    });
  }

  if (!daysSeen || daysWithSpread / daysSeen < 0.5) return null;


  const filled = cells.map((c, i) => {
    const m = mean(c.ys);
    return {
      bucket: i + 1,
      n: c.ys.length,
      meanBps: m,
      hitPct: c.ys.length ? c.ys.filter((y) => y > 0).length / c.ys.length : 0,
    } satisfies QuantileCell;
  });
  if (filled.some((c) => c.n < 10)) return null;

  const top = cells[QUANTILES - 1]!.ys;
  const bot = cells[0]!.ys;
  const mt = mean(top);
  const mb = mean(bot);
  const st = sd(top, mt);
  const sb = sd(bot, mb);
  const se = Math.sqrt((st * st) / Math.max(1, top.length) + (sb * sb) / Math.max(1, bot.length));

  const spec = FEATURE_SPECS[featureIndex]!;
  return {
    key: spec.key,
    label: labelOf(spec.key),
    group: spec.bucket,
    cells: filled,
    spreadBps: mt - mb,
    tStat: se > 0 ? (mt - mb) / se : 0,
  };
}

function symbolRecords(samples: Sample[]): SymbolRecord[] {
  const byDate = new Map<string, Sample[]>();
  for (const s of samples) {
    const arr = byDate.get(s.date);
    if (arr) arr.push(s);
    else byDate.set(s.date, [s]);
  }
  const acc = new Map<string, number[]>();
  for (const rows of byDate.values()) {
    if (rows.length < 3) continue;
    const dayMean = mean(rows.map((r) => r.y));
    for (const r of rows) {
      const arr = acc.get(r.symbol) ?? [];
      arr.push((r.y - dayMean) * 10_000);
      acc.set(r.symbol, arr);
    }
  }
  return [...acc.entries()]
    .filter(([, ys]) => ys.length >= 8)
    .map(([symbol, ys]) => ({
      symbol,
      n: ys.length,
      meanBps: mean(ys),
      hitPct: ys.filter((y) => y > 0).length / ys.length,
    }))
    .sort((a, b) => b.meanBps - a.meanBps);
}

function renderCells(f: FeatureEvidence): string {
  return f.cells
    .map((c) => `q${c.bucket} ${c.meanBps >= 0 ? "+" : ""}${c.meanBps.toFixed(0)}bps (${(c.hitPct * 100).toFixed(0)}% up, n=${c.n})`)
    .join(" | ");
}

/** Build the evidence brief for one account. Throws when there is too little history. */
export async function buildHistoryBrief(args: {
  userId: string;
  horizonDays?: number;
  realMoneyOnly?: boolean;
}): Promise<HistoryBrief> {
  const horizonDays = args.horizonDays ?? 5;
  const data = await buildDataset({
    userId: args.userId,
    horizonDays,
    realMoneyOnly: args.realMoneyOnly ?? false,
    labelMode: "risk_net",
  });
  if (data.samples.length < 150) {
    throw new Error(
      `Not enough recorded history yet: ${data.samples.length} observations over ${data.dates.length} days (need 150).`,
    );
  }

  const features = FEATURE_SPECS.map((_, i) => evidenceFor(data.samples, i))
    .filter((f): f is FeatureEvidence => f !== null)
    .sort((a, b) => Math.abs(b.tStat) - Math.abs(a.tStat));

  const records = symbolRecords(data.samples);
  const bestSymbols = records.slice(0, 8);
  const worstSymbols = records.slice(-8).reverse();

  const strong = features.filter((f) => Math.abs(f.tStat) >= 1.5);
  const weak = features.filter((f) => Math.abs(f.tStat) < 1.5);

  const text = [
    `ACCOUNT HISTORY EVIDENCE — ${data.samples.length} observations of ${data.symbols.length} instruments over ${data.dates.length} trading days (${data.from ?? "?"} → ${data.to ?? "?"}).`,
    `Outcome measured on every row: the realised ${horizonDays}-trading-day return NET of the round-trip dealing cost this account actually pays (${data.roundTripCostBps.toFixed(0)}bps, measured from invoiced fills), divided by the risk the name was carrying, then expressed relative to that same day's average across the candidate list. So it measures SELECTION, not market direction. ${data.tradedSamples} rows are days real money went into the name; ${data.heldSamples} are days it was already held.`,
    "",
    "SIGNAL BUCKETS — what each signal actually delivered on this book (q1 = lowest fifth of that signal on the day, q5 = highest):",
    ...strong.map(
      (f) =>
        `- ${f.label} [${f.group}]: ${renderCells(f)} → q5−q1 ${f.spreadBps >= 0 ? "+" : ""}${f.spreadBps.toFixed(0)}bps (t ${f.tStat.toFixed(2)})`,
    ),
    strong.length ? "" : "- Nothing clears the noise bar yet.",
    weak.length
      ? `SIGNALS WITH NO MEASURABLE EDGE HERE (|t| < 1.5, treat as noise on this book): ${weak
          .map((f) => `${f.label} (${f.spreadBps >= 0 ? "+" : ""}${f.spreadBps.toFixed(0)}bps, t ${f.tStat.toFixed(2)})`)
          .join("; ")}`
      : "",
    "",
    `INSTRUMENT RECORD (mean relative outcome per observation, this account only):`,
    `- Best: ${bestSymbols.map((s) => `${s.symbol} ${s.meanBps >= 0 ? "+" : ""}${s.meanBps.toFixed(0)}bps (${(s.hitPct * 100).toFixed(0)}% up, n=${s.n})`).join("; ") || "n/a"}`,
    `- Worst: ${worstSymbols.map((s) => `${s.symbol} ${s.meanBps >= 0 ? "+" : ""}${s.meanBps.toFixed(0)}bps (${(s.hitPct * 100).toFixed(0)}% up, n=${s.n})`).join("; ") || "n/a"}`,
    "",
    `COST REALITY: a round trip costs about ${data.roundTripCostBps.toFixed(0)}bps here, so any setup whose measured edge is smaller than that is a losing trade however good the signal looks.`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    coverage: {
      samples: data.samples.length,
      dates: data.dates.length,
      symbols: data.symbols.length,
      from: data.from,
      to: data.to,
      horizonDays,
      tradedSamples: data.tradedSamples,
      heldSamples: data.heldSamples,
      roundTripCostBps: data.roundTripCostBps,
    },
    features,
    bestSymbols,
    worstSymbols,
    text,
  };
}
