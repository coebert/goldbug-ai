// Compute cache for overlapping walk-forward runs.
//
// Iterating on the CV/overlap flags is slow for a silly reason: the tape and
// its regime labels do not depend on those flags at all. Dropping the overlap
// from 0% to 75% quadruples the window count, and every window re-derives the
// benchmark index and re-classifies bars it shares with its neighbours. With a
// 252/126 split at 75% overlap the same bar is classified eight times.
//
// This module memoises the flag-independent half of the pipeline:
//
//   tape ──► benchmark index ──► per-bar regime labels ──► per-window vote
//            (per tape)          (per tape + thresholds)   (per window range)
//
// Only the last step depends on the window layout, and even that is keyed by
// bar range, so two overlapping runs that happen to produce identical ranges
// share the result. Changing `overlapPct`, `step`, the CV sampler or the fold
// count therefore costs nothing but the votes for genuinely new ranges.
//
// Pure and in-process: no I/O, no clock, no randomness. Entries are keyed by a
// content fingerprint of the tape, so a changed tape can never serve a stale
// label — there is no TTL to get wrong.

import {
  benchmarkIndex,
  classifyRegimeBars,
  DEFAULT_REGIME_THRESHOLDS,
  dominantRegimeWeighted,
  type DominantRegimeOptions,
  type DominantRegimeResult,
  type IndexPoint,
  type RegimeBar,
  type RegimeLabel,
  type RegimeThresholds,
  type TapeBarLike,
} from "./regime-walk-forward";

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Cheap, stable across runs, good enough to key a memo. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hashNumbers(values: Iterable<number>): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    // Round to 6dp so float noise from different code paths does not fork the
    // cache while genuinely different prices still separate.
    h ^= fnv1a(Number.isFinite(v) ? v.toFixed(6) : "x");
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Content fingerprint of a raw tape (dates + every close in every bar). */
export function tapeFingerprint(bars: readonly TapeBarLike[]): string {
  let h = 0x811c9dc5;
  for (const bar of bars) {
    h ^= fnv1a(bar.date);
    h = Math.imul(h, 0x01000193) >>> 0;
    for (const symbol of Object.keys(bar.closes).sort()) {
      h ^= fnv1a(symbol);
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= hashNumbers([bar.closes[symbol]!]);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `t${bars.length}_${(h >>> 0).toString(36)}`;
}

/** Content fingerprint of a benchmark index series. */
export function indexFingerprint(index: readonly IndexPoint[]): string {
  const dates = fnv1a(index.map((p) => p.date).join("|"));
  const values = hashNumbers(index.map((p) => p.value));
  return `i${index.length}_${dates.toString(36)}_${values.toString(36)}`;
}

/** Canonical key for a threshold set — key order and defaults are normalised. */
export function thresholdKey(thresholds: Partial<RegimeThresholds> = {}): string {
  const merged = { ...DEFAULT_REGIME_THRESHOLDS, ...thresholds } as Record<string, unknown>;
  return Object.keys(merged)
    .sort()
    .map((k) => `${k}=${String(merged[k])}`)
    .join(",");
}

function voteKey(opts: DominantRegimeOptions): string {
  return [
    `w=${opts.weightByConfidence ?? true}`,
    `s=${opts.minDirectionalShare ?? 0.45}`,
    `c=${opts.minConfidence ?? 0.5}`,
  ].join(",");
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export type CacheStats = {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxEntries: number;
  /** hits / (hits + misses), 0 when nothing has been asked for yet. */
  hitRate: number;
  /** Per-namespace hit/miss tallies, useful when tuning what to cache. */
  byNamespace: Record<string, { hits: number; misses: number }>;
};

export const DEFAULT_MAX_ENTRIES = 512;

/**
 * Bounded LRU memo. `Map` preserves insertion order, so re-inserting on read
 * keeps the most recently used entry last and the eviction victim first.
 */
export class RegimeComputeCache {
  private store = new Map<string, unknown>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private ns = new Map<string, { hits: number; misses: number }>();

  constructor(private maxEntries: number = DEFAULT_MAX_ENTRIES) {
    if (maxEntries < 1) throw new Error("RegimeComputeCache: maxEntries must be >= 1");
  }

  /** Generic memo escape hatch — namespace keeps the stats readable. */
  memo<T>(namespace: string, key: string, compute: () => T): T {
    const full = `${namespace}::${key}`;
    const tally = this.ns.get(namespace) ?? { hits: 0, misses: 0 };
    if (this.store.has(full)) {
      const value = this.store.get(full) as T;
      // Refresh recency.
      this.store.delete(full);
      this.store.set(full, value);
      this.hits++;
      tally.hits++;
      this.ns.set(namespace, tally);
      return value;
    }
    const value = compute();
    this.misses++;
    tally.misses++;
    this.ns.set(namespace, tally);
    this.store.set(full, value);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions++;
    }
    return value;
  }

  /** Benchmark index for a tape; keyed by tape content only. */
  benchmarkIndex(bars: readonly TapeBarLike[], fingerprint?: string): IndexPoint[] {
    const fp = fingerprint ?? tapeFingerprint(bars);
    return this.memo("benchmarkIndex", fp, () => benchmarkIndex(bars));
  }

  /**
   * Per-bar regime classification for the WHOLE series, computed once per
   * (series, thresholds). Windows slice this instead of re-classifying.
   */
  regimeBars(
    index: readonly IndexPoint[],
    thresholds: Partial<RegimeThresholds> = {},
    fingerprint?: string,
  ): RegimeBar[] {
    const fp = fingerprint ?? indexFingerprint(index);
    return this.memo("regimeBars", `${fp}|${thresholdKey(thresholds)}`, () =>
      classifyRegimeBars(index, thresholds),
    );
  }

  /** Labels only, derived from the cached bar classification. */
  regimeLabels(
    index: readonly IndexPoint[],
    thresholds: Partial<RegimeThresholds> = {},
    fingerprint?: string,
  ): RegimeLabel[] {
    const fp = fingerprint ?? indexFingerprint(index);
    return this.memo("regimeLabels", `${fp}|${thresholdKey(thresholds)}`, () =>
      this.regimeBars(index, thresholds, fp).map((b) => b.label),
    );
  }

  /**
   * Confidence-weighted regime for one window. Keyed by bar range, so two
   * overlapping runs asking for the same range pay for it once.
   */
  windowRegime(
    index: readonly IndexPoint[],
    start: number,
    end: number,
    thresholds: Partial<RegimeThresholds> = {},
    opts: DominantRegimeOptions = {},
    fingerprint?: string,
  ): DominantRegimeResult {
    const fp = fingerprint ?? indexFingerprint(index);
    const key = `${fp}|${thresholdKey(thresholds)}|${voteKey(opts)}|${start}:${end}`;
    return this.memo("windowRegime", key, () =>
      dominantRegimeWeighted(this.regimeBars(index, thresholds, fp), start, end, opts),
    );
  }

  stats(): CacheStats {
    const asked = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.store.size,
      maxEntries: this.maxEntries,
      hitRate: asked === 0 ? 0 : this.hits / asked,
      byNamespace: Object.fromEntries([...this.ns].map(([k, v]) => [k, { ...v }])),
    };
  }

  /** Drop everything and reset the counters. */
  clear(): void {
    this.store.clear();
    this.ns.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /** Drop entries for one namespace, e.g. after changing the vote rules. */
  invalidateNamespace(namespace: string): number {
    let removed = 0;
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(`${namespace}::`)) {
        this.store.delete(k);
        removed++;
      }
    }
    this.ns.delete(namespace);
    return removed;
  }

  resize(maxEntries: number): void {
    if (maxEntries < 1) throw new Error("RegimeComputeCache: maxEntries must be >= 1");
    this.maxEntries = maxEntries;
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions++;
    }
  }
}

/** Process-wide cache shared by walk-forward runs in the same worker. */
export const regimeCache = new RegimeComputeCache();

export function clearRegimeCache(): void {
  regimeCache.clear();
}

/**
 * Pre-warm the flag-independent stage for a tape so every window in the run —
 * whatever the overlap or CV settings — hits the cache.
 */
export function warmRegimeCache(
  bars: readonly TapeBarLike[],
  thresholds: Partial<RegimeThresholds> = {},
  cache: RegimeComputeCache = regimeCache,
): { index: IndexPoint[]; bars: RegimeBar[]; fingerprint: string } {
  const fp = tapeFingerprint(bars);
  const index = cache.benchmarkIndex(bars, fp);
  const indexFp = indexFingerprint(index);
  return { index, bars: cache.regimeBars(index, thresholds, indexFp), fingerprint: indexFp };
}

/**
 * How much work the cache saved: compares bars classified once against the
 * naive per-window cost implied by the window layout.
 */
export function cacheSavings(
  windows: readonly { testStart: number; testEnd: number }[],
  totalBars: number,
): { naiveBarClassifications: number; cachedBarClassifications: number; speedup: number } {
  const naive = windows.reduce((s, w) => s + Math.max(0, w.testEnd - w.testStart), 0);
  const cached = totalBars;
  return {
    naiveBarClassifications: naive,
    cachedBarClassifications: cached,
    speedup: cached > 0 ? naive / cached : 0,
  };
}
