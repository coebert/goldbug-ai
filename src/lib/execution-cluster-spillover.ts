// Sector-to-sector spillover: which clusters actually couple, and which of
// them drive the joint worst case.
//
// `execution-correlation-calibration.ts` pools every pair into two numbers
// (within-cluster ρ and across-cluster ρ). That is enough to parameterise a
// structure, but it hides the thing you want to know before sizing a
// portfolio: coupling is not uniform across sectors. Tech↔tech and tech↔
// semis can co-move at 0.7 while gold↔tech sits near zero, and the pooled
// "across" number splits the difference and tells you nothing about either.
//
// This module produces two artefacts:
//
//   1. A cluster × cluster spillover matrix (calm, stress and the stress
//      uplift Δ), estimated from the same rolling windows as the calibration,
//      renderable as an ASCII heatmap.
//   2. A tail-contribution summary: given a base simulation metric and one
//      metric per "this cluster was decoupled from the shock" ablation, the
//      share of the joint worst case each cluster is responsible for.
//
// The two answer different halves of the same question. The heatmap says who
// moves together; the contributions say whose co-movement actually costs money.

import {
  fisherMean,
  fisherWeightedMean,
  returnSeries,
  rollingCorrelationWindows,
  sliceCorr,
  type CalibrationOptions,
} from "./execution-correlation-calibration";
import { defaultCluster } from "./execution-correlation-structures";

export type SpilloverCell = {
  /** Pooled correlation across calm windows (NaN when unobserved). */
  calm: number;
  /** Pooled correlation across stressed windows (NaN when unobserved). */
  stress: number;
  /** stress − calm: how much the pair tightens when the tape turns. */
  delta: number;
  /** Symbol pairs contributing to the cell. */
  pairs: number;
  /** Window mass behind the calm estimate (fractional under a soft blend). */
  calmWindows: number;
  /** Window mass behind the stress estimate. */
  stressWindows: number;
};

export type ClusterSpillover = {
  clusters: string[];
  /** Row-major cluster × cluster cells; symmetric, diagonal = intra-cluster. */
  cells: SpilloverCell[][];
  /** Symbols per cluster, for reporting. */
  members: Map<string, string[]>;
  windows: number;
  stressWindows: number;
  window: number;
  step: number;
  basis: "returns" | "absReturns";
};

export type SpilloverLayer = "calm" | "stress" | "delta";

const NAN_CELL = (): SpilloverCell => ({
  calm: Number.NaN,
  stress: Number.NaN,
  delta: Number.NaN,
  pairs: 0,
  calmWindows: 0,
  stressWindows: 0,
});

/**
 * Rolling-window correlation pooled per cluster pair, split calm vs stressed.
 *
 * Same estimator as the scalar calibration — Fisher-z pooling of per-window
 * Pearson correlations on the chosen basis — just bucketed by cluster pair
 * instead of by within/across. Cells with no observed windows stay NaN rather
 * than being filled with the pooled average: an unobserved pair is missing
 * data, not a measured zero.
 */
export function clusterSpilloverMatrix(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  opts: CalibrationOptions = {},
): ClusterSpillover {
  const basis = opts.basis ?? "absReturns";
  const window = Math.max(5, Math.floor(opts.window ?? 60));
  const step = Math.max(1, Math.floor(opts.step ?? 5));
  const rets = returnSeries(seriesBySymbol, basis);
  const symbols = [...rets.keys()];
  const groups = opts.groups ?? new Map(symbols.map((s) => [s, defaultCluster(s)]));
  const groupOf = (s: string) => groups.get(s) ?? "other";

  const members = new Map<string, string[]>();
  for (const s of symbols) {
    const g = groupOf(s);
    const list = members.get(g) ?? [];
    list.push(s);
    members.set(g, list);
  }
  const clusters = [...members.keys()].sort();
  const index = new Map(clusters.map((c, i) => [c, i]));

  const cells: SpilloverCell[][] = clusters.map(() => clusters.map(() => NAN_CELL()));
  if (symbols.length < 2 || !clusters.length) {
    return {
      clusters, cells, members, windows: 0, stressWindows: 0, window, step, basis,
    };
  }

  // Reuse the calibration's window slicing and regime labels so the heatmap
  // and the scalar calibration always describe the same set of windows.
  const rows = rollingCorrelationWindows(seriesBySymbol, { ...opts, basis, window, step });
  // The heatmap pools with the same regime weights as the scalar calibration,
  // so a soft blend softens both consistently rather than leaving the
  // residual comparison scored against a differently-labelled tape.
  const weightByEnd = new Map(rows.map((r) => [r.endIndex, r.stressWeight]));

  // Per cell, the per-window correlations gathered separately by regime.
  const valBuf: number[][][] = clusters.map(() => clusters.map(() => []));
  const wBuf: number[][][] = clusters.map(() => clusters.map(() => []));
  const pairCount: number[][] = clusters.map(() => clusters.map(() => 0));

  const n = Math.min(...symbols.map((s) => rets.get(s)!.length));
  for (let end = window; end <= n; end += step) {
    const from = end - window;
    const stressWeight = weightByEnd.get(end) ?? 0;
    // Pool pairs inside the window first, then pool windows: a cluster pair
    // with 40 symbol pairs must not outvote one with 2 at the regime level.
    const perCell: number[][][] = clusters.map(() => clusters.map(() => []));
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const a = symbols[i]!;
        const b = symbols[j]!;
        const r = sliceCorr(rets.get(a)!, rets.get(b)!, from, end);
        if (!Number.isFinite(r)) continue;
        const ga = index.get(groupOf(a))!;
        const gb = index.get(groupOf(b))!;
        perCell[ga]![gb]!.push(r);
        if (ga !== gb) perCell[gb]![ga]!.push(r);
      }
    }
    for (let a = 0; a < clusters.length; a++) {
      for (let b = 0; b < clusters.length; b++) {
        const vals = perCell[a]![b]!;
        if (!vals.length) continue;
        pairCount[a]![b] = Math.max(pairCount[a]![b]!, vals.length);
        valBuf[a]![b]!.push(fisherMean(vals));
        wBuf[a]![b]!.push(stressWeight);
      }
    }
  }

  for (let a = 0; a < clusters.length; a++) {
    for (let b = 0; b < clusters.length; b++) {
      const vals = valBuf[a]![b]!;
      const sw = wBuf[a]![b]!;
      const cw = sw.map((w) => 1 - w);
      const massOf = (ws: readonly number[]) =>
        vals.reduce((acc, v, i) => (Number.isFinite(v) ? acc + (ws[i] ?? 0) : acc), 0);
      const calmMass = massOf(cw);
      const stressMass = massOf(sw);
      const calm = calmMass > 0 ? fisherWeightedMean(vals, cw) : Number.NaN;
      const stress = stressMass > 0 ? fisherWeightedMean(vals, sw) : Number.NaN;
      cells[a]![b] = {
        calm,
        stress,
        delta: Number.isFinite(calm) && Number.isFinite(stress) ? stress - calm : Number.NaN,
        pairs: pairCount[a]![b]!,
        calmWindows: calmMass,
        stressWindows: stressMass,
      };
    }
  }

  return {
    clusters,
    cells,
    members,
    windows: rows.length,
    stressWindows: rows.reduce((a, r) => a + r.stressWeight, 0),
    window,
    step,
    basis,
  };
}

export const spilloverValue = (cell: SpilloverCell, layer: SpilloverLayer): number =>
  layer === "calm" ? cell.calm : layer === "stress" ? cell.stress : cell.delta;

const SHADES = [" ", "·", ":", "-", "=", "+", "*", "#", "%", "@"];

/** Maps a value in [lo, hi] onto a 10-step shade ramp. */
function shadeOf(v: number, lo: number, hi: number): string {
  if (!Number.isFinite(v)) return "?";
  const span = hi - lo;
  const t = span > 0 ? (v - lo) / span : 0;
  const i = Math.min(SHADES.length - 1, Math.max(0, Math.round(t * (SHADES.length - 1))));
  return SHADES[i]!;
}

/**
 * ASCII heatmap of one layer. Each cell shows the correlation and a shade
 * character so the block structure is visible at a glance in a terminal.
 */
export function formatSpilloverHeatmap(
  m: ClusterSpillover,
  layer: SpilloverLayer = "stress",
): string {
  if (!m.clusters.length) return "(no clusters)";
  const vals = m.cells.flat().map((c) => spilloverValue(c, layer)).filter(Number.isFinite);
  const lo = layer === "delta" ? 0 : Math.min(0, ...vals);
  const hi = vals.length ? Math.max(...vals) : 1;
  const label = (s: string) => s.slice(0, 8).padStart(8);
  const head = ["        ", ...m.clusters.map(label)].join(" ");
  const lines = [head];
  for (let a = 0; a < m.clusters.length; a++) {
    const row = [label(m.clusters[a]!)];
    for (let b = 0; b < m.clusters.length; b++) {
      const v = spilloverValue(m.cells[a]![b]!, layer);
      row.push(
        (Number.isFinite(v) ? `${shadeOf(v, lo, hi)}${v >= 0 ? " " : ""}${v.toFixed(2)}` : "  n/a")
          .padStart(8),
      );
    }
    lines.push(row.join(" "));
  }
  lines.push(
    `  scale ${lo.toFixed(2)} [${SHADES.join("")}] ${hi.toFixed(2)} · `
    + `${layer} layer · ${m.windows} windows (${m.stressWindows} stressed)`,
  );
  return lines.join("\n");
}

export type SpilloverPair = {
  a: string;
  b: string;
  calm: number;
  stress: number;
  delta: number;
};

/** Cluster pairs ranked by how much they tighten under stress. */
export function topSpilloverPairs(m: ClusterSpillover, limit = 8): SpilloverPair[] {
  const out: SpilloverPair[] = [];
  for (let a = 0; a < m.clusters.length; a++) {
    for (let b = a; b < m.clusters.length; b++) {
      const c = m.cells[a]![b]!;
      if (!Number.isFinite(c.delta)) continue;
      out.push({ a: m.clusters[a]!, b: m.clusters[b]!, calm: c.calm, stress: c.stress, delta: c.delta });
    }
  }
  return out.sort((x, y) => y.delta - x.delta).slice(0, limit);
}

// ------------------------------------------------------- tail contributions

export type ClusterAblation = {
  cluster: string;
  /** Metric value with this cluster decoupled from the shock process. */
  metric: number;
  /** Symbols that were decoupled, for reporting. */
  symbols?: number;
};

export type TailContribution = {
  cluster: string;
  metric: number;
  /** ablated − base, oriented so a positive number means the cluster hurt. */
  damage: number;
  /** Share of total positive damage, 0…1 (0 when the cluster is protective). */
  share: number;
  symbols: number;
};

/**
 * Leave-one-cluster-out tail attribution.
 *
 * `base` is the metric with every cluster coupled; each ablation is the same
 * metric on the same random draws with one cluster's symbols decoupled from
 * the common/cluster factors and the stress regime. The improvement from
 * removing a cluster is that cluster's contribution to the joint tail.
 *
 * `orientation` says which direction is bad: drawdowns and returns are
 * `lowerIsWorse`, costs and breach probabilities are `higherIsWorse`. Shares
 * are normalised over the positive damages only, so protective clusters show
 * a negative damage and a zero share rather than distorting the split.
 */
export function clusterTailContributions(
  base: number,
  ablations: readonly ClusterAblation[],
  orientation: "lowerIsWorse" | "higherIsWorse" = "lowerIsWorse",
): TailContribution[] {
  const sign = orientation === "lowerIsWorse" ? 1 : -1;
  const raw = ablations.map((a) => ({
    cluster: a.cluster,
    metric: a.metric,
    damage: sign * (a.metric - base),
    symbols: a.symbols ?? 0,
  }));
  const total = raw.reduce((s, r) => s + Math.max(0, r.damage), 0);
  return raw
    .map((r) => ({ ...r, share: total > 0 ? Math.max(0, r.damage) / total : 0 }))
    .sort((x, y) => y.damage - x.damage);
}

/** Table of the contribution summary, one row per cluster. */
export function formatTailContributions(
  rows: readonly TailContribution[],
  opts: { label?: string; unit?: string; baseline?: number } = {},
): string {
  const unit = opts.unit ?? "%";
  const head = [
    "cluster".padEnd(12),
    "syms".padStart(5),
    `decoupled${unit}`.padStart(13),
    `damage${unit}`.padStart(11),
    "share".padStart(7),
  ].join(" ");
  const lines = [
    opts.label ? opts.label : "",
    opts.baseline !== undefined ? `  baseline (all clusters coupled): ${opts.baseline.toFixed(2)}${unit}` : "",
    head,
  ].filter(Boolean);
  for (const r of rows) {
    lines.push([
      r.cluster.slice(0, 12).padEnd(12),
      String(r.symbols).padStart(5),
      r.metric.toFixed(2).padStart(13),
      (r.damage >= 0 ? "+" : "") + r.damage.toFixed(2).padStart(10),
      `${(r.share * 100).toFixed(1)}%`.padStart(7),
    ].join(" "));
  }
  return lines.join("\n");
}
