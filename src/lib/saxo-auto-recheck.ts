/**
 * Policy for the automatic "Re-check Saxo blocks" run.
 *
 * The app cannot observe the moment an appropriateness test is submitted at
 * Saxo, so the closest reliable signal is the user ticking that section off on
 * the unblock checklist. When that happens we re-probe the broker for them
 * instead of waiting for a manual tap.
 *
 * Two guards keep this from hammering the broker:
 *   - a cooldown between automatic runs (manual taps are never gated), and
 *   - a "nothing to check" short-circuit when no blocks remain.
 */

export const AUTO_RECHECK_COOLDOWN_MS = 5 * 60 * 1000;

export type AutoRecheckInput = {
  /** Epoch ms of the last automatic run, or null when never run. */
  lastRunAt: number | null;
  now: number;
  /** Active broker blocks right now. */
  blockCount: number;
  /** Checklist sections the user has marked as completed at Saxo. */
  completedCategories: number;
  /** A run is already in flight. */
  busy: boolean;
  cooldownMs?: number;
};

export type AutoRecheckDecision = {
  run: boolean;
  reason:
    | "no_blocks"
    | "no_completed_sections"
    | "busy"
    | "cooldown"
    | "assessment_updated";
};

export function decideAutoRecheck(input: AutoRecheckInput): AutoRecheckDecision {
  if (input.busy) return { run: false, reason: "busy" };
  if (input.blockCount <= 0) return { run: false, reason: "no_blocks" };
  if (input.completedCategories <= 0) return { run: false, reason: "no_completed_sections" };

  const cooldown = input.cooldownMs ?? AUTO_RECHECK_COOLDOWN_MS;
  if (input.lastRunAt !== null && input.now - input.lastRunAt < cooldown) {
    return { run: false, reason: "cooldown" };
  }
  return { run: true, reason: "assessment_updated" };
}

const LAST_RUN_KEY = "saxo-auto-recheck-last-run";

export function readLastAutoRecheck(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_RUN_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeLastAutoRecheck(at: number): void {
  try {
    window.localStorage.setItem(LAST_RUN_KEY, String(at));
  } catch {
    /* ignore unwritable storage */
  }
}
