// Saving and loading a fitted coupling calibration.
//
// `calibrateCorrelations` turns a price tape into four numbers plus the rolling
// window series behind them. That fit is the expensive, tape-dependent part of
// a Monte-Carlo run, and it is also the part that silently changes when the
// tape does: one more trading day of history, a different `--from`, a provider
// revision, and the "same" command produces a different structure. A run is
// only reproducible if the calibration state travels with it.
//
// This module is the serialisation boundary. A snapshot carries three things:
//
//   1. the fitted parameters — pooled calm/stress ρ, the derived structure, the
//      cluster map, and (optionally) every rolling window behind the pooling,
//      so the estimate can be re-inspected without the tape;
//   2. the options that produced them — window, step, basis, shrink, stress
//      trigger — because a ρ without its estimator is not a measurement;
//   3. a fingerprint of the tape it was fitted on — symbols, bar count, date
//      range and a hash of the closes — so reloading against a *different*
//      tape is detected and reported rather than quietly accepted.
//
// The fingerprint is the point. Loading a snapshot pins the coupling; the
// fingerprint tells you whether the rest of the run is the same experiment.
//
// Pure module: no filesystem, no clock beyond an explicit `createdAt`. The fs
// wrappers live in `execution-correlation-snapshot.server.ts`.

import { z } from "zod";

import {
  makeCorrelationStructure,
  type CorrelationStructure,
  type CorrelationStructureKind,
} from "./execution-correlation-structures";
import type {
  CalibrationBasis,
  CalibrationOptions,
  CorrelationCalibration,
  PooledRho,
  RollingCorrelationWindow,
} from "./execution-correlation-calibration";
import type { FoldCalibration } from "./execution-oos-calibration";

/**
 * Bumped only on a breaking change to the on-disk shape. Loaders refuse a
 * version they do not understand rather than guessing at the missing fields.
 */
export const CALIBRATION_SNAPSHOT_VERSION = 1 as const;

// ------------------------------------------------------------------ fingerprint

/**
 * Prices are hashed at 6 significant figures: enough to survive a JSON float
 * round-trip, tight enough that the hash means "byte-identical tape".
 *
 * The hash alone is NOT the verdict. Adjusted closes are recomputed by the
 * data provider on every pull, so the same historical bar comes back differing
 * around the 7th figure between two fetches minutes apart. Over thousands of
 * bars, some of those land on a rounding boundary and flip the hash, so an
 * exact hash marks a genuinely identical tape as changed. `tapeDigest` below
 * is the tolerant check that decides whether a run is a reproduction; the hash
 * is kept as a cheap "bit-for-bit identical" signal and as a file label.
 */
const FINGERPRINT_PRECISION = 6;
const quantise = (v: number, precision: number) =>
  (Number.isFinite(v) ? Number(v.toPrecision(precision)) : 0);

/** FNV-1a over the quantised closes. Deterministic and order-independent of
 *  Map insertion because the symbols are sorted first. */
export function tapeFingerprint(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  precision: number = FINGERPRINT_PRECISION,
): string {


  let h = 0x811c9dc5;
  const push = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const sym of [...seriesBySymbol.keys()].sort()) {
    push(sym);
    push("|");
    for (const v of seriesBySymbol.get(sym)!) {
      push(String(quantise(v, precision)));
      push(",");
    }
    push(";");
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type TapeIdentity = {
  symbols: string[];
  bars: number;
  /** Optional, purely descriptive: the CLI date range the tape was pulled for. */
  from?: string;
  to?: string;
  priceMode?: string;
  fingerprint: string;
};

export function tapeIdentity(
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  meta: { from?: string; to?: string; priceMode?: string } = {},
): TapeIdentity {
  const symbols = [...seriesBySymbol.keys()].sort();
  const bars = symbols.length ? (seriesBySymbol.get(symbols[0]!)?.length ?? 0) : 0;
  return {
    symbols,
    bars,
    ...(meta.from ? { from: meta.from } : {}),
    ...(meta.to ? { to: meta.to } : {}),
    ...(meta.priceMode ? { priceMode: meta.priceMode } : {}),
    fingerprint: tapeFingerprint(seriesBySymbol),
  };
}

// ---------------------------------------------------------------------- schema

const finite = z.number().refine((v) => Number.isFinite(v), "must be finite");
/** Pooled ρ may legitimately be NaN (no windows in that regime); JSON has no
 *  NaN, so it is written as null and read back as NaN. */
const maybeRho = z.number().nullable();

const pooledSchema = z.object({
  rho: maybeRho,
  sd: finite,
  windows: z.number().int().nonnegative(),
});

const windowSchema = z.object({
  endIndex: z.number().int().nonnegative(),
  bars: z.number().int().nonnegative(),
  withinRho: maybeRho,
  acrossRho: maybeRho,
  withinPairs: z.number().int().nonnegative(),
  acrossPairs: z.number().int().nonnegative(),
  stressShare: finite,
  stressed: z.boolean(),
});

const structureSchema = z.object({
  kind: z.enum(["independent", "global", "blocks", "contagion"]),
  withinRho: finite,
  acrossRho: finite,
  stressWithinRho: finite,
  stressAcrossRho: finite,
  /** symbol → cluster; a plain object so the file is readable and diffable. */
  groups: z.record(z.string(), z.string()),
});

const optionsSchema = z.object({
  window: z.number().int().positive(),
  step: z.number().int().positive(),
  basis: z.enum(["returns", "absReturns"]),
  shrink: finite,
  stressZ: finite,
  minStressShare: finite,
});

const foldSchema = z.object({
  fold: z.number().int().nonnegative(),
  kind: z.enum(["blocks", "contagion"]),
  trainStart: z.number().int().nonnegative(),
  trainEnd: z.number().int().nonnegative(),
  testStart: z.number().int().nonnegative(),
  testEnd: z.number().int().nonnegative(),
  structure: structureSchema,
  trainWindows: z.number().int().nonnegative(),
  trainStressWindows: z.number().int().nonnegative(),
  stressStarved: z.boolean(),
});

export const calibrationSnapshotSchema = z.object({
  version: z.literal(CALIBRATION_SNAPSHOT_VERSION),
  createdAt: z.string(),
  label: z.string().optional(),
  tape: z.object({
    symbols: z.array(z.string()),
    bars: z.number().int().nonnegative(),
    from: z.string().optional(),
    to: z.string().optional(),
    priceMode: z.string().optional(),
    fingerprint: z.string(),
  }),
  options: optionsSchema,
  /** The structure the run actually used, derived from the pooled estimates. */
  structure: structureSchema,
  pooled: z.object({
    calm: z.object({ within: pooledSchema, across: pooledSchema }),
    stress: z.object({ within: pooledSchema, across: pooledSchema }),
    stressShare: finite,
    clusters: z.array(z.string()),
  }),
  /** Omitted with `includeWindows: false` to keep big files small. */
  windows: z.array(windowSchema).optional(),
  /** Per-fold structures from an --oos-corr run, when there were any. */
  folds: z.array(foldSchema).optional(),
});

export type CalibrationSnapshot = z.infer<typeof calibrationSnapshotSchema>;

// ------------------------------------------------------------------- encoding

const nanToNull = (v: number) => (Number.isFinite(v) ? v : null);
const nullToNan = (v: number | null) => (v === null ? Number.NaN : v);

const encodePooled = (p: PooledRho) => ({
  rho: nanToNull(p.rho),
  sd: Number.isFinite(p.sd) ? p.sd : 0,
  windows: p.windows,
});
const decodePooled = (p: z.infer<typeof pooledSchema>): PooledRho => ({
  rho: nullToNan(p.rho),
  sd: p.sd,
  windows: p.windows,
});

const encodeWindow = (w: RollingCorrelationWindow) => ({
  ...w,
  withinRho: nanToNull(w.withinRho),
  acrossRho: nanToNull(w.acrossRho),
});
const decodeWindow = (w: z.infer<typeof windowSchema>): RollingCorrelationWindow => ({
  ...w,
  withinRho: nullToNan(w.withinRho),
  acrossRho: nullToNan(w.acrossRho),
});

const encodeStructure = (s: CorrelationStructure) => ({
  kind: s.kind,
  withinRho: s.withinRho,
  acrossRho: s.acrossRho,
  stressWithinRho: s.stressWithinRho,
  stressAcrossRho: s.stressAcrossRho,
  groups: Object.fromEntries([...s.groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
});

/**
 * Rebuilds a structure from its stored parameters.
 *
 * The four ρ values are passed explicitly, so `makeCorrelationStructure` fills
 * in no defaults and the reloaded structure is bit-identical to the saved one.
 */
export function structureFromSnapshotFields(
  s: z.infer<typeof structureSchema>,
  groupsOverride?: ReadonlyMap<string, string>,
): CorrelationStructure {
  return makeCorrelationStructure({
    kind: s.kind as CorrelationStructureKind,
    withinRho: s.withinRho,
    acrossRho: s.acrossRho,
    stressWithinRho: s.stressWithinRho,
    stressAcrossRho: s.stressAcrossRho,
    groups: groupsOverride ?? new Map(Object.entries(s.groups)),
  });
}

/** The structure the snapshot's run used. */
export const structureFromSnapshot = (
  snap: CalibrationSnapshot,
  groupsOverride?: ReadonlyMap<string, string>,
): CorrelationStructure => structureFromSnapshotFields(snap.structure, groupsOverride);

/** Per-fold structures, keyed by fold index, for replaying an --oos-corr run. */
export function foldStructuresFromSnapshot(
  snap: CalibrationSnapshot,
  groupsOverride?: ReadonlyMap<string, string>,
): Map<number, CorrelationStructure> {
  const out = new Map<number, CorrelationStructure>();
  for (const f of snap.folds ?? []) {
    out.set(f.fold, structureFromSnapshotFields(f.structure, groupsOverride));
  }
  return out;
}

/** The estimator settings, ready to hand back to `calibrateCorrelations`. */
export function optionsFromSnapshot(
  snap: CalibrationSnapshot,
  groups?: ReadonlyMap<string, string>,
): CalibrationOptions {
  return {
    window: snap.options.window,
    step: snap.options.step,
    basis: snap.options.basis as CalibrationBasis,
    shrink: snap.options.shrink,
    stressZ: snap.options.stressZ,
    minStressShare: snap.options.minStressShare,
    ...(groups ? { groups } : {}),
  };
}

// ------------------------------------------------------------------- building

export type SnapshotFoldWindow = {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
};

export type BuildSnapshotInput = {
  calibration: CorrelationCalibration;
  structure: CorrelationStructure;
  tape: TapeIdentity;
  /** Stress trigger used when labelling windows; not carried on the calibration. */
  stressZ: number;
  minStressShare: number;
  label?: string;
  createdAt?: string;
  /** Keep the full rolling-window series. Default true. */
  includeWindows?: boolean;
  folds?: Array<{ calibration: FoldCalibration; window: SnapshotFoldWindow }>;
};

export function buildCalibrationSnapshot(input: BuildSnapshotInput): CalibrationSnapshot {
  const { calibration: cal } = input;
  const snap: CalibrationSnapshot = {
    version: CALIBRATION_SNAPSHOT_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.label ? { label: input.label } : {}),
    tape: input.tape,
    options: {
      window: cal.window,
      step: cal.step,
      basis: cal.basis,
      shrink: cal.shrink,
      stressZ: input.stressZ,
      minStressShare: input.minStressShare,
    },
    structure: encodeStructure(input.structure),
    pooled: {
      calm: {
        within: encodePooled(cal.calm.within),
        across: encodePooled(cal.calm.across),
      },
      stress: {
        within: encodePooled(cal.stress.within),
        across: encodePooled(cal.stress.across),
      },
      stressShare: cal.stressShare,
      clusters: cal.clusters,
    },
    ...(input.includeWindows === false
      ? {}
      : { windows: cal.windows.map(encodeWindow) }),
    ...(input.folds?.length
      ? {
        folds: input.folds.map(({ calibration, window }) => ({
          fold: calibration.fold,
          kind: calibration.kind,
          ...window,
          structure: encodeStructure(calibration.structure),
          trainWindows: calibration.trainWindows,
          trainStressWindows: calibration.trainStressWindows,
          stressStarved: calibration.stressStarved,
        })),
      }
      : {}),
  };
  // Round-trip through the schema so a malformed snapshot fails at write time,
  // where the fix is cheap, not at read time three weeks later.
  return calibrationSnapshotSchema.parse(snap);
}

/** Reconstructs the pooled estimates (NaN restored) for reporting. */
export function pooledFromSnapshot(snap: CalibrationSnapshot): {
  calm: { within: PooledRho; across: PooledRho };
  stress: { within: PooledRho; across: PooledRho };
} {
  return {
    calm: {
      within: decodePooled(snap.pooled.calm.within),
      across: decodePooled(snap.pooled.calm.across),
    },
    stress: {
      within: decodePooled(snap.pooled.stress.within),
      across: decodePooled(snap.pooled.stress.across),
    },
  };
}

/** The rolling windows, if the snapshot kept them. */
export const windowsFromSnapshot = (
  snap: CalibrationSnapshot,
): RollingCorrelationWindow[] => (snap.windows ?? []).map(decodeWindow);

export const serialiseCalibrationSnapshot = (snap: CalibrationSnapshot): string =>
  `${JSON.stringify(snap, null, 2)}\n`;

export function parseCalibrationSnapshot(raw: string | unknown): CalibrationSnapshot {
  const json = typeof raw === "string" ? JSON.parse(raw) : raw;
  const version = (json as { version?: unknown })?.version;
  if (version !== CALIBRATION_SNAPSHOT_VERSION) {
    throw new Error(
      `Unsupported calibration snapshot version ${String(version)}; `
      + `this build reads version ${CALIBRATION_SNAPSHOT_VERSION}. Re-fit with --save-calib.`,
    );
  }
  return calibrationSnapshotSchema.parse(json);
}

// -------------------------------------------------------------- verification

export type SnapshotTapeCheck = {
  matches: boolean;
  /** Same fingerprint = same bars, same prices, same order. */
  fingerprintMatches: boolean;
  missingSymbols: string[];
  extraSymbols: string[];
  snapshotBars: number;
  tapeBars: number;
  reasons: string[];
};

/**
 * Compares a snapshot against the tape a run is about to use.
 *
 * A mismatch is not fatal — replaying an old calibration on new bars is a
 * legitimate thing to do deliberately — but it means the run is no longer a
 * reproduction, so the caller should say so loudly rather than let the two
 * quietly diverge.
 */
export function verifySnapshotAgainstTape(
  snap: CalibrationSnapshot,
  seriesBySymbol: ReadonlyMap<string, readonly number[]>,
  meta: { from?: string; to?: string; priceMode?: string } = {},
): SnapshotTapeCheck {
  const now = tapeIdentity(seriesBySymbol, meta);
  const snapSyms = new Set(snap.tape.symbols);
  const nowSyms = new Set(now.symbols);
  const missing = snap.tape.symbols.filter((s) => !nowSyms.has(s));
  const extra = now.symbols.filter((s) => !snapSyms.has(s));
  const fingerprintMatches = now.fingerprint === snap.tape.fingerprint;

  const reasons: string[] = [];
  if (missing.length) reasons.push(`missing symbols: ${missing.join(", ")}`);
  if (extra.length) reasons.push(`extra symbols: ${extra.join(", ")}`);
  if (now.bars !== snap.tape.bars) {
    reasons.push(`bar count ${now.bars} vs ${snap.tape.bars} at fit time`);
  }
  if (snap.tape.from && meta.from && snap.tape.from !== meta.from) {
    reasons.push(`from ${meta.from} vs ${snap.tape.from}`);
  }
  if (snap.tape.to && meta.to && snap.tape.to !== meta.to) {
    reasons.push(`to ${meta.to} vs ${snap.tape.to}`);
  }
  if (snap.tape.priceMode && meta.priceMode && snap.tape.priceMode !== meta.priceMode) {
    reasons.push(`price mode ${meta.priceMode} vs ${snap.tape.priceMode}`);
  }
  if (!fingerprintMatches && !reasons.length) {
    reasons.push("prices differ (same symbols and bar count, different values)");
  }

  return {
    matches: fingerprintMatches && !reasons.length,
    fingerprintMatches,
    missingSymbols: missing,
    extraSymbols: extra,
    snapshotBars: snap.tape.bars,
    tapeBars: now.bars,
    reasons,
  };
}

// ---------------------------------------------------------------- description

const rho = (p: PooledRho) =>
  Number.isFinite(p.rho) ? `${p.rho.toFixed(3)} ±${p.sd.toFixed(3)} (n=${p.windows})` : "n/a (n=0)";

export function describeSnapshot(snap: CalibrationSnapshot): string {
  const p = pooledFromSnapshot(snap);
  const lines = [
    `calibration snapshot v${snap.version}`
      + (snap.label ? ` "${snap.label}"` : "") + ` fitted ${snap.createdAt}`,
    `tape: ${snap.tape.symbols.length} symbols × ${snap.tape.bars} bars`
      + (snap.tape.from ? ` ${snap.tape.from}→${snap.tape.to ?? "?"}` : "")
      + (snap.tape.priceMode ? ` (${snap.tape.priceMode})` : "")
      + ` fingerprint ${snap.tape.fingerprint}`,
    `estimator: window=${snap.options.window} step=${snap.options.step} `
      + `basis=${snap.options.basis} shrink=${snap.options.shrink} `
      + `stressZ=${snap.options.stressZ} minStressShare=${snap.options.minStressShare}`,
    `calm   within ${rho(p.calm.within)}   across ${rho(p.calm.across)}`,
    `stress within ${rho(p.stress.within)}   across ${rho(p.stress.across)}`,
    `structure: ${snap.structure.kind} `
      + `within ${snap.structure.withinRho.toFixed(3)} / across ${snap.structure.acrossRho.toFixed(3)}, `
      + `stress ${snap.structure.stressWithinRho.toFixed(3)} / ${snap.structure.stressAcrossRho.toFixed(3)}`,
  ];
  if (snap.windows?.length) {
    lines.push(
      `windows: ${snap.windows.length} kept `
      + `(${(snap.pooled.stressShare * 100).toFixed(1)}% stressed)`,
    );
  }
  if (snap.folds?.length) {
    const starved = snap.folds.filter((f) => f.stressStarved).length;
    lines.push(
      `folds: ${snap.folds.length} per-fold ${snap.folds[0]!.kind} structures`
      + (starved ? ` (${starved} stress-starved)` : ""),
    );
  }
  return lines.join("\n");
}

export function describeTapeCheck(check: SnapshotTapeCheck): string {
  if (check.matches) return "tape matches the snapshot fingerprint — run is a reproduction";
  return `tape DIFFERS from the snapshot: ${check.reasons.join("; ")}`
    + " — the coupling is pinned but the rest of the run is not a reproduction";
}
