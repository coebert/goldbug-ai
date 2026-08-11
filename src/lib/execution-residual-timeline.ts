// Residual correlation over time: *when* and *where* the two-parameter
// coupling assumptions break down.
//
// `execution-correlation-diagnostics.ts` scores a fitted structure against the
// pooled cluster × cluster matrix — one number per cluster pair per regime,
// averaged over the whole tape. That answers "where" and hides "when". A
// structure can look well-calibrated on average while being badly wrong for
// six months around a crisis, and averaging is exactly what conceals it.
//
// This module keeps the time axis. For every rolling window it measures the
// realised correlation of every cluster pair, asks the structure what it would
// have implied *at that window's regime state* (the same soft stress weight the
// calibration uses, so the comparison respects the blend), and stores the
// signed residual. The result is a cluster-pair × time matrix per structure:
//
//   - a heatmap that shows drift, regime episodes and pair-specific blowouts;
//   - worst-episode and worst-pair rankings, so the eye is pointed at the
//     window that actually costs you;
//   - a blocks-vs-contagion comparison per window, which is the honest version
//     of "contagion fits better" — it says *when* it fits better, and whether
//     the advantage is a handful of stressed windows or a standing edge.
//
// Everything is pure and derived from the same rolling windows as the
// calibration, so a residual timeline always describes the fit you shipped.

import {
  calibrateCorrelations,
  fisherMean,
  returnSeries,
  rollingCorrelationWindows,
  sliceCorr,
  structureFromCalibration,
  type CalibrationOptions,
} from "./execution-correlation-calibration";
import {
  defaultCluster,
  regimeRhos,
  type CorrelationStructure,
} from "./execution-correlation-structures";

/** The only two structures with a within/across split worth scoring over time. */
export type TimelineStructureKind = "blocks" | "contagion";

export const DEFAULT_TIMELINE_KINDS: TimelineStructureKind[] = ["blocks", "contagion"];

// ------------------------------------------------------------------- types

export type TimelineWindow = {
  /** Index into the rolling-window series. */
  index: number;
  /** Last return-index in the window (its right edge). */
  endIndex: number;
  /** Calendar label for the right edge, when dates were supplied. */
  date: string | null;
  /** Share of the window's bars above the stress z threshold. */
  stressShare: number;
  /** Soft regime membership in [0, 1] — 0 calm, 1 fully stressed. */
  stressWeight: number;
};

export type ResidualCell = {
  /** Position in `windows`. */
  window: number;
  /** Correlation measured for this cluster pair inside this window. */
  realised: number;
  /** Correlation the structure implies at this window's regime state. */
  implied: number;
  /** implied − realised. Positive = the structure over-couples the pair here. */
  error: number;
  /** Symbol pairs behind the realised estimate. */
  pairs: number;
};

export type PairResidualSeries = {
  a: string;
  b: string;
  /** true when a === b, i.e. the pair is scored against ρ_within. */
  within: boolean;
  /** One cell per observed window; unobserved windows are omitted. */
  cells: ResidualCell[];
  rmse: number;
  /** Mean signed error: the pair's standing over/under-coupling. */
  bias: number;
  /** Largest |error| cell. */
  worst: ResidualCell | null;
  /** RMSE over the calm half of the window mass (weighted by 1 − stressWeight). */
  rmseCalm: number;
  /** RMSE over the stressed mass (weighted by stressWeight). */
  rmseStress: number;
  /** secondHalf − firstHalf mean |error|: is the misfit growing over time? */
  drift: number;
};

export type ResidualEpisode = {
  window: number;
  date: string | null;
  stressWeight: number;
  /** Pair-count-weighted RMSE across all cluster pairs in this window. */
  rmse: number;
  /** Worst cluster pair in this window. */
  worstPair: string;
  worstError: number;
};

export type StructureResidualTimeline = {
  kind: TimelineStructureKind;
  structure: CorrelationStructure;
  pairs: PairResidualSeries[];
  /** Weighted RMSE per window, aligned with `ResidualTimeline.windows`. */
  rmseByWindow: number[];
  rmse: number;
  bias: number;
  rmseCalm: number;
  rmseStress: number;
  /** Windows ranked by weighted RMSE, worst first. */
  episodes: ResidualEpisode[];
  /** Pairs ranked by RMSE, worst first. */
  worstPairs: PairResidualSeries[];
};

export type ResidualTimeline = {
  clusters: string[];
  windows: TimelineWindow[];
  window: number;
  step: number;
  basis: "returns" | "absReturns";
  structures: StructureResidualTimeline[];
  /**
   * Per-window `rmse(blocks) − rmse(contagion)`, when both were scored.
   * Positive means contagion fits that window better.
   */
  contagionEdgeByWindow: number[];
  /**
   * Share of *decisive* windows where contagion fits better. Calm windows are
   * usually exact ties — the two structures share their calm parameters — so
   * counting them would drown the comparison in noise-free draws.
   */
  contagionWinRate: number;
  /** Share of windows where the two structures are indistinguishable. */
  contagionTieRate: number;
  /**
   * Does contagion's advantage come from the stressed windows, as its story
   * requires, or is it a flat offset that says nothing about regimes?
   */
  contagionEdgeCalm: number;
  contagionEdgeStress: number;
};

// --------------------------------------------------------------- plumbing

const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;

const rms = (xs: readonly number[]) =>
  xs.length ? Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length) : Number.NaN;

const weightedRms = (xs: readonly number[], ws: readonly number[]) => {
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i] ?? 0;
    if (!(w > 0) || !Number.isFinite(xs[i]!)) continue;
    num += w * xs[i]! ** 2;
    den += w;
  }
  return den > 0 ? Math.sqrt(num / den) : Number.NaN;
};

export const pairLabel = (a: string, b: string) => (a === b ? a : `${a}↔${b}`);

// ------------------------------------------------------------- computation

export type ResidualTimelineOptions = CalibrationOptions & {
  /** Which structures to score. Defaults to blocks and contagion. */
  kinds?: readonly TimelineStructureKind[];
  /**
   * Pre-fitted structures by kind. Anything missing is calibrated from the
   * tape, so passing a loaded snapshot scores exactly that saved state.
   */
  structures?: ReadonlyMap<TimelineStructureKind, CorrelationStructure>;
  /** Per-bar calendar labels aligned with the close series, for the axis. */
  dates?: readonly string[];
};

/**
 * Cluster-pair × time residuals for each structure.
 *
 * The realised leg reuses the calibration's own estimator: per-window Pearson
 * correlations on the chosen basis, Fisher-pooled inside each cluster pair so a
 * pair with forty symbol combinations does not swamp one with two. The implied
 * leg evaluates the structure at that window's soft stress weight, so a window
 * that is 30% stressed is scored against 30%-blended coupling rather than being
 * forced into one of two boxes.
 */
export function residualTimeline(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  opts: ResidualTimelineOptions = {},
): ResidualTimeline {
  const basis = opts.basis ?? "absReturns";
  const window = Math.max(5, Math.floor(opts.window ?? 60));
  const step = Math.max(1, Math.floor(opts.step ?? 5));
  const kinds = [...new Set(opts.kinds ?? DEFAULT_TIMELINE_KINDS)];

  const rets = returnSeries(seriesBySymbol, basis);
  const symbols = [...rets.keys()];
  const groups = opts.groups ?? new Map(symbols.map((s) => [s, defaultCluster(s)]));
  const groupOf = (s: string) => groups.get(s) ?? "other";
  const clusters = [...new Set(symbols.map(groupOf))].sort();
  const index = new Map(clusters.map((c, i) => [c, i]));

  const rows = rollingCorrelationWindows(seriesBySymbol, { ...opts, basis, window, step });
  const empty: ResidualTimeline = {
    clusters, windows: [], window, step, basis, structures: [],
    contagionEdgeByWindow: [], contagionWinRate: Number.NaN,
    contagionEdgeCalm: Number.NaN, contagionEdgeStress: Number.NaN,
  };
  if (symbols.length < 2 || !clusters.length || !rows.length) return empty;

  // A return at index i is the move into close i+1, so the window's right edge
  // in calendar terms is one bar ahead of its return index.
  const dateAt = (endIndex: number) => opts.dates?.[endIndex + 1] ?? opts.dates?.at(-1) ?? null;

  const windows: TimelineWindow[] = rows.map((r, i) => ({
    index: i,
    endIndex: r.endIndex,
    date: dateAt(r.endIndex),
    stressShare: r.stressShare,
    stressWeight: r.stressWeight,
  }));

  // Realised correlation per cluster pair per window, measured once and reused
  // for every structure: the tape does not change between assumptions.
  type PairKey = string;
  const realised = new Map<PairKey, Map<number, { rho: number; pairs: number }>>();
  const keyOf = (a: number, b: number) => `${Math.min(a, b)}|${Math.max(a, b)}`;

  rows.forEach((row, w) => {
    const from = row.endIndex - window;
    const buckets = new Map<PairKey, number[]>();
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const r = sliceCorr(
          rets.get(symbols[i]!)!, rets.get(symbols[j]!)!, from, row.endIndex,
        );
        if (!Number.isFinite(r)) continue;
        const key = keyOf(index.get(groupOf(symbols[i]!))!, index.get(groupOf(symbols[j]!))!);
        (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r);
      }
    }
    for (const [key, vals] of buckets) {
      const rho = fisherMean(vals);
      if (!Number.isFinite(rho)) continue;
      const series = realised.get(key) ?? realised.set(key, new Map()).get(key)!;
      series.set(w, { rho, pairs: vals.length });
    }
  });

  // Structures: whatever the caller pinned, otherwise fitted from this tape.
  const calibration = kinds.some((k) => !opts.structures?.has(k))
    ? calibrateCorrelations(seriesBySymbol, { ...opts, basis, window, step })
    : null;

  const structures: StructureResidualTimeline[] = kinds.map((kind) => {
    const structure = opts.structures?.get(kind)
      ?? structureFromCalibration(calibration!, kind, groups);

    // regimeRhos does the calm→stress blend; feeding it the window's soft
    // weight is what makes the implied leg regime-aware over time.
    const impliedAt = windows.map((w) => regimeRhos(structure, w.stressWeight));

    const pairs: PairResidualSeries[] = [];
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a; b < clusters.length; b++) {
        const series = realised.get(keyOf(a, b));
        if (!series?.size) continue;
        const within = a === b;
        const cells: ResidualCell[] = [];
        for (const [w, obs] of [...series].sort((x, y) => x[0] - y[0])) {
          const implied = within ? impliedAt[w]!.withinRho : impliedAt[w]!.acrossRho;
          cells.push({
            window: w,
            realised: obs.rho,
            implied,
            error: implied - obs.rho,
            pairs: obs.pairs,
          });
        }
        const errs = cells.map((c) => c.error);
        const abs = errs.map(Math.abs);
        const half = Math.floor(cells.length / 2);
        pairs.push({
          a: clusters[a]!,
          b: clusters[b]!,
          within,
          cells,
          rmse: rms(errs),
          bias: mean(errs),
          worst: cells.length
            ? cells.reduce((m, c) => (Math.abs(c.error) > Math.abs(m.error) ? c : m))
            : null,
          rmseCalm: weightedRms(errs, cells.map((c) => 1 - windows[c.window]!.stressWeight)),
          rmseStress: weightedRms(errs, cells.map((c) => windows[c.window]!.stressWeight)),
          drift: half ? mean(abs.slice(half)) - mean(abs.slice(0, half)) : 0,
        });
      }
    }

    // Per window: pair-count-weighted RMSE across cluster pairs, so the
    // timeline reflects the misfit a whole portfolio would have felt.
    const rmseByWindow = windows.map((_, w) => {
      const errs: number[] = [];
      const ws: number[] = [];
      for (const p of pairs) {
        const cell = p.cells.find((c) => c.window === w);
        if (!cell) continue;
        errs.push(cell.error);
        ws.push(Math.max(1, cell.pairs));
      }
      return weightedRms(errs, ws);
    });

    const episodes: ResidualEpisode[] = windows
      .map((win, w) => {
        let worstPair = "";
        let worstError = 0;
        for (const p of pairs) {
          const cell = p.cells.find((c) => c.window === w);
          if (cell && Math.abs(cell.error) > Math.abs(worstError)) {
            worstError = cell.error;
            worstPair = pairLabel(p.a, p.b);
          }
        }
        return {
          window: w,
          date: win.date,
          stressWeight: win.stressWeight,
          rmse: rmseByWindow[w]!,
          worstPair,
          worstError,
        };
      })
      .filter((e) => Number.isFinite(e.rmse))
      .sort((x, y) => y.rmse - x.rmse);

    const allErrs = pairs.flatMap((p) => p.cells.map((c) => c.error));
    const calmW = pairs.flatMap((p) =>
      p.cells.map((c) => 1 - windows[c.window]!.stressWeight));
    const stressW = pairs.flatMap((p) => p.cells.map((c) => windows[c.window]!.stressWeight));

    return {
      kind,
      structure,
      pairs,
      rmseByWindow,
      rmse: rms(allErrs),
      bias: mean(allErrs),
      rmseCalm: weightedRms(allErrs, calmW),
      rmseStress: weightedRms(allErrs, stressW),
      episodes,
      worstPairs: [...pairs].sort((x, y) => y.rmse - x.rmse),
    };
  });

  // ------------------------------------------------------ blocks vs contagion
  const blocks = structures.find((s) => s.kind === "blocks");
  const contagion = structures.find((s) => s.kind === "contagion");
  const edge = blocks && contagion
    ? windows.map((_, w) => {
      const b = blocks.rmseByWindow[w]!;
      const c = contagion.rmseByWindow[w]!;
      return Number.isFinite(b) && Number.isFinite(c) ? b - c : Number.NaN;
    })
    : [];
  const observedEdge = edge.filter(Number.isFinite);
  const TIE = 1e-9;
  const decisive = observedEdge.filter((v) => Math.abs(v) > TIE);

  return {
    clusters,
    windows,
    window,
    step,
    basis,
    structures,
    contagionEdgeByWindow: edge,
    contagionWinRate: decisive.length
      ? decisive.filter((v) => v > 0).length / decisive.length
      : Number.NaN,
    contagionTieRate: observedEdge.length
      ? (observedEdge.length - decisive.length) / observedEdge.length
      : Number.NaN,
    contagionEdgeCalm: weightedMean(edge, windows.map((w) => 1 - w.stressWeight)),
    contagionEdgeStress: weightedMean(edge, windows.map((w) => w.stressWeight)),
  };
}

function weightedMean(xs: readonly number[], ws: readonly number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i] ?? 0;
    if (!(w > 0) || !Number.isFinite(xs[i]!)) continue;
    num += w * xs[i]!;
    den += w;
  }
  return den > 0 ? num / den : Number.NaN;
}

// ------------------------------------------------------------- presentation

/** Signed shade ramp: `+` family over-couples, `x` family under-couples. */
const POS = ["·", "+", "*", "#", "@"];
const NEG = ["·", ",", ";", "x", "X"];

export function residualShade(error: number, scale: number): string {
  if (!Number.isFinite(error)) return " ";
  const mag = scale > 0 ? Math.min(1, Math.abs(error) / scale) : 0;
  const i = Math.min(4, Math.round(mag * 4));
  return error >= 0 ? POS[i]! : NEG[i]!;
}

/**
 * Buckets the window axis down to `columns` printable slots, averaging the
 * signed error inside each bucket. Bucketing signed errors (not absolute ones)
 * is deliberate: a bucket where the structure is wrong in both directions is
 * less alarming than one where it is consistently wrong the same way.
 */
export function bucketWindows(count: number, columns: number): number[][] {
  const cols = Math.max(1, Math.min(columns, count));
  const buckets: number[][] = Array.from({ length: cols }, () => []);
  for (let w = 0; w < count; w++) {
    buckets[Math.min(cols - 1, Math.floor((w * cols) / count))]!.push(w);
  }
  return buckets;
}

export type HeatmapOptions = {
  /** Printable time columns. */
  columns?: number;
  /** Error magnitude that saturates the ramp. Defaults to the 95th pctile. */
  scale?: number;
};

/**
 * Cluster-pair × time ASCII heatmap of the signed residual, with a stress
 * strip underneath so regime episodes line up with the misfit above them.
 */
export function formatResidualHeatmap(
  t: ResidualTimeline,
  s: StructureResidualTimeline,
  opts: HeatmapOptions = {},
): string {
  if (!t.windows.length || !s.pairs.length) return "(no residual windows)";
  const buckets = bucketWindows(t.windows.length, opts.columns ?? 48);
  const all = s.pairs.flatMap((p) => p.cells.map((c) => Math.abs(c.error))).sort((a, b) => a - b);
  const scale = opts.scale
    ?? (all.length ? all[Math.floor(all.length * 0.95)] ?? all.at(-1)! : 1);

  const label = (v: string) => v.slice(0, 17).padEnd(17);
  const lines: string[] = [];
  lines.push(`Residual heatmap — ${s.kind}: implied − realised ρ per cluster pair over time`);

  for (const p of [...s.pairs].sort((x, y) => y.rmse - x.rmse)) {
    const byWindow = new Map(p.cells.map((c) => [c.window, c.error]));
    const strip = buckets
      .map((ws) => {
        const vals = ws.map((w) => byWindow.get(w)).filter((v): v is number => v !== undefined);
        return vals.length ? residualShade(mean(vals), scale) : " ";
      })
      .join("");
    lines.push(
      `${label(pairLabel(p.a, p.b))}|${strip}| rmse ${p.rmse.toFixed(3)} `
      + `bias ${p.bias >= 0 ? "+" : ""}${p.bias.toFixed(3)}`,
    );
  }

  const stressStrip = buckets
    .map((ws) => {
      const m = mean(ws.map((w) => t.windows[w]!.stressWeight));
      return m > 0.75 ? "█" : m > 0.4 ? "▓" : m > 0.15 ? "▒" : m > 0.02 ? "░" : " ";
    })
    .join("");
  lines.push(`${label("stress regime")}|${stressStrip}|`);

  const first = t.windows[0]!.date ?? `w0`;
  const last = t.windows.at(-1)!.date ?? `w${t.windows.length - 1}`;
  lines.push(`${" ".repeat(17)} ${first.padEnd(Math.max(1, buckets.length - first.length))}${last}`);
  lines.push(
    `  over-coupled ${POS.join("")} / under-coupled ${NEG.join("")} · `
    + `saturates at ±${scale.toFixed(3)} · ${t.windows.length} windows`
    + ` of ${t.window} bars, step ${t.step}`,
  );
  return lines.join("\n");
}

/** Worst windows, i.e. *when* the assumption failed. */
export function formatResidualEpisodes(s: StructureResidualTimeline, limit = 8): string {
  const lines = [`Worst windows — ${s.kind}`];
  lines.push([
    "date".padEnd(12), "stressW".padStart(8), "rmse".padStart(7),
    "worst pair".padEnd(20), "err".padStart(7),
  ].join(" "));
  for (const e of s.episodes.slice(0, limit)) {
    lines.push([
      (e.date ?? `w${e.window}`).padEnd(12),
      e.stressWeight.toFixed(2).padStart(8),
      e.rmse.toFixed(3).padStart(7),
      e.worstPair.padEnd(20),
      `${e.worstError >= 0 ? "+" : ""}${e.worstError.toFixed(3)}`.padStart(7),
    ].join(" "));
  }
  return lines.join("\n");
}

/** Full report: heatmap and episodes per structure, then the head-to-head. */
export function formatResidualTimeline(
  t: ResidualTimeline,
  opts: HeatmapOptions & { episodes?: number } = {},
): string {
  if (!t.windows.length) return "Residual timeline: no windows (tape too short?)";
  const out: string[] = [];
  for (const s of t.structures) {
    out.push(formatResidualHeatmap(t, s, opts));
    out.push("");
    out.push(formatResidualEpisodes(s, opts.episodes ?? 8));
    out.push(
      `  overall rmse ${s.rmse.toFixed(3)} (calm ${s.rmseCalm.toFixed(3)} / `
      + `stress ${s.rmseStress.toFixed(3)}), bias ${s.bias >= 0 ? "+" : ""}${s.bias.toFixed(3)}`,
    );
    const drifting = [...s.pairs].sort((a, b) => b.drift - a.drift)[0];
    if (drifting && Number.isFinite(drifting.drift)) {
      out.push(
        `  fastest-drifting pair: ${pairLabel(drifting.a, drifting.b)} `
        + `${drifting.drift >= 0 ? "+" : ""}${drifting.drift.toFixed(3)} mean |err| second half vs first`,
      );
    }
    out.push("");
  }

  if (Number.isFinite(t.contagionWinRate)) {
    out.push("Blocks vs contagion, per window");
    out.push(
      `  contagion fits better in ${(t.contagionWinRate * 100).toFixed(0)}% of decisive windows `
      + `(${(t.contagionTieRate * 100).toFixed(0)}% are ties) · `
      + `mean edge calm ${t.contagionEdgeCalm.toFixed(3)} / stress ${t.contagionEdgeStress.toFixed(3)}`,
    );
    out.push(
      t.contagionEdgeStress > t.contagionEdgeCalm
        ? "  The advantage concentrates in stressed windows — that is the contagion story doing work."
        : "  The advantage does not concentrate in stress; contagion is acting as a flat offset, not a regime model.",
    );
  }
  return out.join("\n");
}
