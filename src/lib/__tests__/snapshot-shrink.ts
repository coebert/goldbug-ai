import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import { resolveSizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";
import { expectNoCounterexample, minimize, shrinkNumber } from "./fuzz-shrink";

/**
 * Counterexample minimization for snapshot mismatches.
 *
 * `fuzz-shrink` minimizes *invariant* failures — something illegal happened.
 * Snapshot failures are a different animal: nothing is illegal, a number simply
 * moved. The raw failure is a wall of diffed fields over a 200-signal cohort at
 * one corner of an 18-cell grid, and the useful question is never "what does
 * the whole diff say" but "what is the smallest input that still moves a
 * number, and which number moves first".
 *
 * This module answers that by shrinking the *case* — cohort size, seed-built
 * rows, grid coordinate (risk × gap weight), and the caps — while the rendered
 * summary keeps differing from the reference in the same fields. It also
 * shrinks the mismatch itself to the minimal set of fields that genuinely
 * disagree, so a single moved value is reported as a single moved value rather
 * than the twelve downstream metrics it drags with it.
 *
 * Two modes, both built on the same `minimize` engine:
 *
 *   - Differential: a reference renderer (an older implementation, an
 *     independent model, a recorded fixture generator) can be evaluated on any
 *     candidate, so the cohort and caps can be shrunk freely.
 *   - Pinned: only recorded values exist, so shrinking works over the grid
 *     coordinates that have pinned values, plus the field set.
 */

// ---------------------------------------------------------------------------
// Snapshot shapes and diffing
// ---------------------------------------------------------------------------

export type SnapshotShape = Record<string, unknown>;

/** Flatten nested snapshot objects/arrays into `a.b.0.c` → value pairs. */
export function flattenShape(value: unknown, prefix = ""): Record<string, unknown> {
  if (value === null || typeof value !== "object") return { [prefix || "value"]: value };
  const out: Record<string, unknown> = {};
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return { [prefix || "value"]: Array.isArray(value) ? "[]" : "{}" };
  for (const [key, child] of entries) {
    Object.assign(out, flattenShape(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

export type FieldMismatch = { path: string; expected: unknown; actual: unknown };

const same = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number"
    ? Math.abs(a - b) < 1e-9 || (Number.isNaN(a) && Number.isNaN(b))
    : Object.is(a, b);

/** Every field where `actual` departs from `expected`, in stable path order. */
export function diffShapes(expected: unknown, actual: unknown): FieldMismatch[] {
  const e = flattenShape(expected);
  const a = flattenShape(actual);
  const paths = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();
  return paths
    .filter((p) => !same(e[p], a[p]))
    .map((p) => ({ path: p, expected: e[p], actual: a[p] }));
}

/**
 * The identity of a mismatch: which fields moved, not by how much.
 *
 * Shrinking must keep chasing the *same* discrepancy. Magnitudes change as the
 * cohort gets smaller — that is the point — so only the field set is pinned.
 */
export function mismatchSignature(diff: readonly FieldMismatch[]): string {
  return diff.map((d) => d.path).sort().join(",");
}

const show = (v: unknown) =>
  typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : JSON.stringify(v) ?? String(v);

export function formatDiff(diff: readonly FieldMismatch[], limit = 12): string {
  const head = diff.slice(0, limit).map((d) => `${d.path}: ${show(d.expected)} → ${show(d.actual)}`);
  if (diff.length > limit) head.push(`… and ${diff.length - limit} more field(s)`);
  return head.join("\n");
}

/**
 * Reduce a mismatch to the fields that are independently different.
 *
 * A snapshot object usually carries derived values (return per unit, drawdown,
 * vs-baseline) that all move when one primitive moves. Fields whose paths are
 * prefixes of, or nested under, another differing field are collapsed into the
 * parent so the report leads with the root that changed.
 */
export function minimalMismatchFields(diff: readonly FieldMismatch[]): FieldMismatch[] {
  const paths = diff.map((d) => d.path);
  return diff.filter((d) => !paths.some((p) => p !== d.path && d.path.startsWith(`${p}.`)));
}

// ---------------------------------------------------------------------------
// The case being shrunk
// ---------------------------------------------------------------------------

/**
 * A replay case is a seed plus a size plus where on the grid it is evaluated.
 * The cohort is rebuilt from (seed, size) rather than carried around, so a
 * shrunk case stays reproducible from two integers.
 */
export type ReplayCase = {
  seed: number;
  /** Number of signals to build from the seed. */
  size: number;
  risk: RiskLevel;
  gapWeight: number;
  limits: SizingLimits;
};

export type CaseRenderer = (input: ReplayCase, trades: readonly SignalTrade[]) => SnapshotShape;

/** How a candidate case is turned into a cohort. */
export type CohortBuilder = (seed: number, size: number) => SignalTrade[];

const riskIndex = (risk: RiskLevel) => Math.max(0, RISK_LEVELS.indexOf(risk));

/**
 * Simpler candidate cases, cheapest and highest-yield first.
 *
 * Order matters: cutting the cohort in half removes the most noise per step, so
 * size shrinks first; the grid coordinate and caps are simplified only once the
 * cohort has stopped getting smaller.
 */
export function shrinkReplayCase(input: ReplayCase, { minSize = 1 } = {}): ReplayCase[] {
  const out: ReplayCase[] = [];
  const push = (patch: Partial<ReplayCase>) => out.push({ ...input, ...patch });

  // 1. Cohort size — halves, then a coarse ladder, then single signals near the end.
  for (const size of [
    Math.floor(input.size / 2),
    Math.floor((input.size * 2) / 3),
    input.size - 10,
    input.size - 1,
  ]) {
    if (size >= minSize && size < input.size) push({ size });
  }

  // 2. Grid coordinate — toward the plainest cell (lowest risk, zero gap weight).
  if (input.gapWeight !== 0) push({ gapWeight: 0 });
  for (const w of shrinkNumber(input.gapWeight, { min: 0, integer: true })) push({ gapWeight: w });
  const ri = riskIndex(input.risk);
  for (let i = 0; i < ri; i++) push({ risk: RISK_LEVELS[i] });

  // 3. Caps — a mismatch that survives loose caps is not a cap-interaction bug.
  for (const v of shrinkNumber(input.limits.maxPositionSize, { min: 0.1 })) {
    push({ limits: resolveSizingLimits({ ...input.limits, maxPositionSize: v }) });
  }
  for (const v of shrinkNumber(input.limits.maxConcurrentSignals, { min: 1, integer: true })) {
    push({ limits: resolveSizingLimits({ ...input.limits, maxConcurrentSignals: v }) });
  }
  for (const v of shrinkNumber(input.limits.maxTotalDeployedPct, { min: 1 })) {
    push({ limits: resolveSizingLimits({ ...input.limits, maxTotalDeployedPct: v }) });
  }

  return out;
}

export function describeReplayCase(input: ReplayCase): string {
  return [
    `seed ${input.seed}, ${input.size} signal${input.size === 1 ? "" : "s"}`,
    `grid cell: ${input.risk} @ gap weight ${input.gapWeight}`,
    `caps: position ${input.limits.maxPositionSize}x, concurrent ${input.limits.maxConcurrentSignals}, deployed ${input.limits.maxTotalDeployedPct}%`,
  ].join("\n");
}

/** A copy-pasteable line that rebuilds exactly this case. */
export function replayCaseRepro(input: ReplayCase): string {
  return `{ seed: ${input.seed}, size: ${input.size}, risk: "${input.risk}", gapWeight: ${input.gapWeight}, limits: { maxPositionSize: ${input.limits.maxPositionSize}, maxConcurrentSignals: ${input.limits.maxConcurrentSignals}, maxTotalDeployedPct: ${input.limits.maxTotalDeployedPct} } }`;
}

// ---------------------------------------------------------------------------
// Differential minimization
// ---------------------------------------------------------------------------

export type SnapshotMismatch = {
  /** The smallest case still producing the same mismatch. */
  value: ReplayCase;
  /** Fields that differ on the minimized case, derived roots only. */
  diff: FieldMismatch[];
  /** Full field diff on the minimized case. */
  fullDiff: FieldMismatch[];
  signature: string;
  steps: number;
  report: string;
};

/**
 * Shrink `input` while `render` and `reference` keep disagreeing in the same
 * fields. Returns null when they agree on the original case.
 */
export function minimizeSnapshotMismatch(
  input: ReplayCase,
  build: CohortBuilder,
  render: CaseRenderer,
  reference: CaseRenderer,
  opts: { maxSteps?: number; minSize?: number } = {},
): SnapshotMismatch | null {
  const check = (value: ReplayCase): string | null => {
    let diff: FieldMismatch[];
    try {
      const trades = build(value.seed, value.size);
      diff = diffShapes(reference(value, trades), render(value, trades));
    } catch (e) {
      // A candidate that throws is not the same failure; treat it as a pass so
      // shrinking never drifts onto an unrelated crash.
      void e;
      return null;
    }
    if (diff.length === 0) return null;
    // The message leads with the field paths so `failureSignature` (which
    // strips numbers) keeps shrinking anchored to the same fields.
    return `snapshot mismatch [${mismatchSignature(diff)}] ${formatDiff(diff, 4).replace(/\n/g, "; ")}`;
  };

  const initial = check(input);
  if (initial === null) return null;

  const min = minimize(input, check, (v) => shrinkReplayCase(v, { minSize: opts.minSize ?? 1 }), {
    maxSteps: opts.maxSteps ?? 200,
  });

  const trades = build(min.value.seed, min.value.size);
  const fullDiff = diffShapes(reference(min.value, trades), render(min.value, trades));
  const diff = minimalMismatchFields(fullDiff);

  const report = [
    "",
    "Replay summary changed. Minimized counterexample:",
    "",
    describeReplayCase(min.value)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
    "",
    `    repro: ${replayCaseRepro(min.value)}`,
    "",
    `  smallest change (${diff.length} root field${diff.length === 1 ? "" : "s"}, ${fullDiff.length} total):`,
    "",
    formatDiff(diff)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
    "",
    `  shrunk from ${input.size} to ${min.value.size} signals in ${min.steps} step${min.steps === 1 ? "" : "s"}.`,
    "",
  ].join("\n");

  return { value: min.value, diff, fullDiff, signature: mismatchSignature(fullDiff), steps: min.steps, report };
}

/** Assert two renderers agree; on failure, fail with the minimized case. */
export function expectNoSnapshotMismatch(
  input: ReplayCase,
  build: CohortBuilder,
  render: CaseRenderer,
  reference: CaseRenderer,
  context: string,
  opts: { maxSteps?: number; minSize?: number } = {},
): void {
  const found = minimizeSnapshotMismatch(input, build, render, reference, opts);
  if (!found) return;
  throw new Error(`${found.report}\n  context: ${context}\n`);
}

// ---------------------------------------------------------------------------
// Pinned-value minimization (no reference implementation available)
// ---------------------------------------------------------------------------

export type PinnedCells = Record<string, SnapshotShape>;

export const cellKey = (risk: RiskLevel, gapWeight: number) => `${risk}@${gapWeight}`;

/**
 * Shrink over grid coordinates only, against recorded per-cell values.
 *
 * Used where the only reference is the committed snapshot: the cohort cannot be
 * shrunk (no pinned value exists for a subset), but the *grid* can, which
 * answers "which is the plainest cell that moved, and what moved in it".
 */
export function minimizeGridMismatch(
  pinned: PinnedCells,
  actual: (risk: RiskLevel, gapWeight: number) => SnapshotShape,
  coords: readonly { risk: RiskLevel; gapWeight: number }[],
): {
  cell: { risk: RiskLevel; gapWeight: number };
  diff: FieldMismatch[];
  affectedCells: number;
  report: string;
} | null {
  const failing = coords
    .filter((c) => pinned[cellKey(c.risk, c.gapWeight)])
    .map((c) => ({
      coord: c,
      diff: diffShapes(pinned[cellKey(c.risk, c.gapWeight)], actual(c.risk, c.gapWeight)),
    }))
    .filter((x) => x.diff.length > 0);

  if (failing.length === 0) return null;

  // "Smallest" = plainest cell: lowest risk level, then lowest gap weight,
  // then the fewest fields moved.
  const sorted = [...failing].sort(
    (a, b) =>
      riskIndex(a.coord.risk) - riskIndex(b.coord.risk) ||
      a.coord.gapWeight - b.coord.gapWeight ||
      a.diff.length - b.diff.length,
  );
  const smallest = sorted[0];
  const roots = minimalMismatchFields(smallest.diff);

  const report = [
    "",
    `Replay summary changed in ${failing.length} of ${coords.length} grid cell(s).`,
    "",
    `  smallest affected cell: ${smallest.coord.risk} @ gap weight ${smallest.coord.gapWeight}`,
    "",
    formatDiff(roots)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
    "",
    failing.length > 1
      ? `  also changed: ${failing
          .slice(1)
          .map((f) => cellKey(f.coord.risk, f.coord.gapWeight))
          .join(", ")}`
      : "  no other cell changed.",
    "",
    "  If this change is intended, update the pinned values in one diff.",
    "",
  ].join("\n");

  return { cell: smallest.coord, diff: roots, affectedCells: failing.length, report };
}

/** Re-export so suites can minimize invariant and snapshot failures from one import. */
export { expectNoCounterexample };
