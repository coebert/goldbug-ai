/**
 * Cross-process resume: a replay stopped mid-flight and finished elsewhere must
 * land on exactly the same tape and P&L as one that never stopped.
 *
 * The suspend/resume path in the same process is already covered (chunked
 * replays in the implementation-equivalence suite). This suite raises the bar:
 * the intermediate state is serialised to disk, and a *new* Bun process — with
 * an empty module registry, no warm caches, no shared closures — reads it back,
 * rebuilds the cohort from the seed alone, and finishes the run.
 *
 * That makes any hidden state fatal rather than invisible: a module-level
 * accumulator, a memoised rank table, a value derived once and kept in a
 * closure would all survive a chunk boundary inside one process, but none of
 * them survives a process boundary. If the resumed result matches byte for
 * byte, the checkpoint really does contain the whole replay.
 *
 * Comparisons are exact — every figure is an integer micro-unit.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cohortForSeed,
  decode,
  encode,
  finaliseReplay,
  runSegment,
  runWholeReplay,
  startCheckpoint,
  type Checkpoint,
  type ReplayResult,
} from "./resumable-replay";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed } from "./fuzz-seed";

const FILE = "src/lib/__tests__/breakout-replay-cross-process-resume.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const CLI = "src/lib/__tests__/resume-replay-cli.ts";

type Finished = { pid: number; result: ReplayResult };

/** Runs the resume CLI in a brand-new process and returns what it wrote. */
function resumeInNewProcess(state: Checkpoint): Finished {
  const dir = mkdtempSync(join(tmpdir(), "replay-resume-"));
  try {
    const statePath = join(dir, "checkpoint.json");
    const outPath = join(dir, "result.json");
    writeFileSync(statePath, encode(state), "utf8");
    execFileSync("bun", [CLI, statePath, outPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return JSON.parse(readFileSync(outPath, "utf8")) as Finished;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The figures a resumed run has to reproduce, not just "roughly". */
function fingerprint(r: ReplayResult) {
  return {
    tape: r.tape,
    terminalCashMicros: r.terminalCashMicros,
    totalCostMicros: r.totalCostMicros,
    pnlMicros: r.pnlMicros,
    filled: r.filled,
    cashTrace: r.steps.map((s) => s.cashMicros),
    holdingsTrace: r.steps.map((s) => s.holdingsMicros),
    costTrace: r.steps.map((s) => s.cumulativeCostMicros),
  };
}

describe("replay resume across a process boundary", () => {
  it("a checkpointed replay finished in a new process matches the baseline", () => {
    for (let i = 0; i < 4; i++) {
      const seed = caseSeed(BASE_SEED, "cross-process", i);
      const cohort = cohortForSeed(seed);
      const total = cohort.plan.signals.length;
      const ctx = `case ${i} seed=${seed} — ${REPRO}`;

      // Stop roughly a third of the way in, with positions still open.
      const cut = Math.max(1, Math.floor(total / 3));
      const mid = runSegment(cohort, startCheckpoint(cohort), cut);

      const finished = resumeInNewProcess(mid);
      expect(finished.pid, `resume did not run out of process: ${ctx}`).not.toBe(process.pid);
      expect(fingerprint(finished.result), `resumed replay diverged from baseline: ${ctx}`).toEqual(
        fingerprint(runWholeReplay(cohort)),
      );
    }
  }, 120_000);

  it("the resume point does not matter — any cut lands on the same tape", () => {
    const seed = caseSeed(BASE_SEED, "cut-points", 0);
    const cohort = cohortForSeed(seed);
    const total = cohort.plan.signals.length;
    const baseline = fingerprint(runWholeReplay(cohort));
    const ctx = `seed=${seed} — ${REPRO}`;

    for (const cut of [0, 1, Math.floor(total / 2), total - 1, total]) {
      const at = Math.max(0, Math.min(total, cut));
      const mid = runSegment(cohort, startCheckpoint(cohort), at);
      const finished = resumeInNewProcess(mid);
      expect(fingerprint(finished.result), `cut at ${at} diverged: ${ctx}`).toEqual(baseline);
    }
  }, 120_000);

  it("a checkpoint survives repeated JSON round-trips and re-suspension", () => {
    for (let i = 0; i < 3; i++) {
      const seed = caseSeed(BASE_SEED, "round-trip", i);
      const cohort = cohortForSeed(seed);
      const total = cohort.plan.signals.length;
      const ctx = `case ${i} seed=${seed} — ${REPRO}`;

      // Suspend and re-serialise every few steps, as a chunked job would.
      let state = startCheckpoint(cohort);
      const stride = Math.max(1, Math.floor(total / 7));
      for (let cursor = 0; cursor < total; cursor += stride) {
        state = decode(encode(runSegment(cohort, state, Math.min(total, cursor + stride))));
      }

      expect(fingerprint(finaliseReplay(cohort, state)), `serialise loop diverged: ${ctx}`).toEqual(
        fingerprint(runWholeReplay(cohort)),
      );
    }
  });

  it("the checkpoint carries the whole replay — the cohort is rebuilt, not shipped", () => {
    const seed = caseSeed(BASE_SEED, "seed-only", 0);
    const cohort = cohortForSeed(seed);
    const mid = runSegment(cohort, startCheckpoint(cohort), Math.max(1, cohort.plan.signals.length >> 1));
    const wire = JSON.parse(encode(mid)) as Record<string, unknown>;

    // Only state crosses the wire: no rows, no plan, no costs, no capital.
    expect(Object.keys(wire).sort()).toEqual(
      ["cashMicros", "costMicros", "cursor", "open", "seed", "steps", "tape", "version"].sort(),
    );
    // And the resuming process still needs the seed to rebuild the market.
    expect(cohortForSeed(seed).rows).toEqual(cohort.rows);
  });

  it("a tampered or stale checkpoint is refused rather than silently resumed", () => {
    const seed = caseSeed(BASE_SEED, "tamper", 0);
    const cohort = cohortForSeed(seed);
    const mid = runSegment(cohort, startCheckpoint(cohort), 3);

    expect(() => decode(JSON.stringify({ ...mid, version: 99 }))).toThrow(/unsupported checkpoint version/);
    expect(() => runSegment(cohortForSeed(seed + 1), mid, 5)).toThrow(/does not match cohort seed/);
    expect(() => finaliseReplay(cohort, mid)).toThrow(/not finished/);
  });

  it("negative control: resuming from a corrupted bank is caught", () => {
    const seed = caseSeed(BASE_SEED, "control", 0);
    const cohort = cohortForSeed(seed);
    const total = cohort.plan.signals.length;
    const mid = runSegment(cohort, startCheckpoint(cohort), Math.max(1, Math.floor(total / 3)));

    // One micro-unit of drift in the carried cash must change the outcome.
    const drifted = resumeInNewProcess({ ...mid, cashMicros: mid.cashMicros + 1 });
    expect(fingerprint(drifted.result)).not.toEqual(fingerprint(runWholeReplay(cohort)));
  }, 120_000);
});
