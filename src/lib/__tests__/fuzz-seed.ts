/**
 * Deterministic seeding for the fuzz workloads.
 *
 * Every fuzz suite draws its randomness from a single base seed so a CI
 * failure is reproducible on a laptop with one command. The base seed is
 * fixed by default (so main is stable run to run) but can be overridden:
 *
 *   FUZZ_SEED=1234 bunx vitest run src/lib/__tests__/*.fuzz.test.ts
 *
 * Set FUZZ_SEED=random to deliberately explore new inputs; the chosen seed is
 * logged at suite start and repeated in every failure message, so a red run
 * always tells you exactly which seed to replay.
 */

/** The default base seed. Bump it only when you intend to change coverage. */
export const DEFAULT_FUZZ_SEED = 20260810;

/** Resolve the base seed for a suite from the environment (or the default). */
export function resolveFuzzSeed(): number {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.["FUZZ_SEED"];
  if (!raw) return DEFAULT_FUZZ_SEED;
  if (raw.toLowerCase() === "random") return (Math.random() * 0xffffffff) >>> 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`FUZZ_SEED must be a number or "random", got: ${raw}`);
  }
  return parsed >>> 0;
}

/**
 * Mix a base seed with a per-case index and a stable label so different
 * blocks inside one suite never share a stream, yet the whole run is
 * reproducible from the single base seed.
 */
export function caseSeed(base: number, label: string, index: number): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  h = Math.imul(h ^ (index + 0x85ebca6b), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** Deterministic PRNG (mulberry32) — same seed, same stream, every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Copy-pasteable command that replays exactly the failing case. */
export function reproCommand(base: number, file: string): string {
  return `FUZZ_SEED=${base} bunx vitest run ${file}`;
}

/**
 * Failure context attached to every fuzz assertion: the base seed, the case
 * seed and the replay command, plus whatever payload the case wants to show.
 */
export function fuzzContext(
  base: number,
  file: string,
  label: string,
  index: number,
  payload?: unknown,
): string {
  return JSON.stringify({
    baseSeed: base,
    case: `${label}#${index}`,
    caseSeed: caseSeed(base, label, index),
    repro: reproCommand(base, file),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Announce the seed once per suite so CI logs always carry the repro. */
export function announceFuzzSeed(base: number, file: string): void {
  // eslint-disable-next-line no-console
  console.log(`[fuzz] base seed ${base} — replay with: ${reproCommand(base, file)}`);
}
