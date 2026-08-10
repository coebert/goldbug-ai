import { expect } from "vitest";

/**
 * Automatic counterexample minimization for the fuzz suites.
 *
 * A raw fuzz failure is usually a 300-signal cohort with random caps: enough
 * to prove a bug exists, useless for diagnosing it. This module shrinks a
 * failing case to a locally minimal one — the fewest signals, the smallest
 * caps, the plainest values that still violate the same invariant — and prints
 * it alongside the seed so the failure can be reproduced and read at a glance.
 *
 * Strategy is greedy delta debugging: repeatedly propose simpler candidates,
 * keep the first that still fails *with the same invariant*, and stop when no
 * candidate does. Requiring the same invariant matters — otherwise shrinking
 * drifts onto an unrelated failure and reports a misleading minimum.
 */

/** Run an assertion block; return its failure message, or null if it passed. */
export function attempt(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Failures are matched by "signature" rather than exact text, because messages
 * embed indexes and values that change as the case shrinks. The signature is
 * the message with numbers stripped — enough to distinguish "negative cash"
 * from "peak over cap" without pinning the specifics.
 */
export function failureSignature(message: string): string {
  return message
    .split("\n")[0]
    .replace(/-?\d+(\.\d+)?(e[+-]?\d+)?/gi, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// ---------------------------------------------------------------------------
// Generic shrinkers
// ---------------------------------------------------------------------------

/**
 * Candidate sublists, cheapest simplification first: halves, then contiguous
 * chunk removals at decreasing granularity, then single-element removals.
 * This is ddmin's candidate set, ordered so big wins land early.
 */
export function shrinkList<T>(items: readonly T[]): T[][] {
  const n = items.length;
  if (n <= 1) return [];
  const out: T[][] = [];
  out.push(items.slice(0, Math.floor(n / 2)));
  out.push(items.slice(Math.floor(n / 2)));
  for (let parts = 4; parts <= 8 && parts < n; parts *= 2) {
    const chunk = Math.ceil(n / parts);
    for (let start = 0; start < n; start += chunk) {
      out.push([...items.slice(0, start), ...items.slice(start + chunk)]);
    }
  }
  if (n <= 24) for (let i = 0; i < n; i++) out.push([...items.slice(0, i), ...items.slice(i + 1)]);
  return out.filter((c) => c.length > 0 && c.length < n);
}

/** Candidate simpler numbers: toward zero, toward one, and rounded. */
export function shrinkNumber(value: number, { min = 0, integer = false } = {}): number[] {
  if (!Number.isFinite(value)) return [0, 1];
  const raw = [min, 1, value / 2, value - 1, Math.round(value), Number(value.toFixed(1))];
  const out = raw
    .map((v) => (integer ? Math.round(v) : v))
    .filter((v) => Number.isFinite(v) && v >= min && Math.abs(v) < Math.abs(value) - 1e-9);
  return [...new Set(out)];
}

export type Minimized<T> = {
  value: T;
  message: string;
  signature: string;
  /** Accepted simplification steps. */
  steps: number;
  /** Candidates evaluated — useful when a shrink budget is being tuned. */
  tried: boolean;
};

/**
 * Shrink `input` while `check` keeps failing with the same signature.
 *
 * `candidates` proposes simpler versions of a value; it is called repeatedly
 * until a full pass produces no accepted candidate, or the budget is spent.
 */
export function minimize<T>(
  input: T,
  check: (value: T) => string | null,
  candidates: (value: T) => T[],
  { maxSteps = 200 } = {},
): Minimized<T> {
  const first = check(input);
  if (first === null) {
    return { value: input, message: "", signature: "", steps: 0, tried: false };
  }
  const signature = failureSignature(first);

  let best = input;
  let message = first;
  let steps = 0;

  for (let pass = 0; pass < 40; pass++) {
    let improved = false;
    for (const candidate of candidates(best)) {
      if (steps >= maxSteps) return { value: best, message, signature, steps, tried: true };
      const result = check(candidate);
      steps++;
      if (result !== null && failureSignature(result) === signature) {
        best = candidate;
        message = result;
        improved = true;
        break; // restart the pass from the simpler case
      }
    }
    if (!improved) break;
  }

  return { value: best, message, signature, steps, tried: true };
}

/**
 * Assert a case passes; on failure, minimize it and fail with the smallest
 * reproduction instead of the original haystack.
 *
 * `describe` renders the minimized value for the failure message — keep it
 * short and copy-pasteable (counts, caps, the handful of rows that matter).
 */
export function expectNoCounterexample<T>(
  input: T,
  check: (value: T) => string | null,
  candidates: (value: T) => T[],
  describe: (value: T) => string,
  context: string,
): void {
  const initial = check(input);
  if (initial === null) return;

  const min = minimize(input, check, candidates);
  const report = [
    "",
    `Invariant violated — ${context}`,
    "",
    `  original failure: ${failureSignature(initial)}`,
    `  minimized in ${min.steps} step${min.steps === 1 ? "" : "s"} to:`,
    "",
    describe(min.value)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
    "",
    `  message: ${min.message.split("\n")[0]}`,
    "",
  ].join("\n");

  expect.fail(report);
}
