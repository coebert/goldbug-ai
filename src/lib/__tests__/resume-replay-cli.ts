/**
 * Resume entry point — run in a *fresh* process by the cross-process replay
 * test. It reads a checkpoint file, rebuilds the cohort from the seed inside
 * it, finishes the replay and writes the result as JSON.
 *
 * Usage: bun src/lib/__tests__/resume-replay-cli.ts <checkpoint.json> <out.json>
 *
 * Deliberately dependency-free beyond the replay module: if finishing a replay
 * ever needed state that only lived in the original process, this would produce
 * a different tape and the test would fail.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { cohortForSeed, decode, finaliseReplay, runSegment } from "./resumable-replay";

function main() {
  const [statePath, outPath] = process.argv.slice(2);
  if (!statePath || !outPath) {
    console.error("usage: resume-replay-cli <checkpoint.json> <out.json>");
    process.exit(2);
    return;
  }

  const state = decode(readFileSync(statePath, "utf8"));
  const cohort = cohortForSeed(state.seed);
  const finished = runSegment(cohort, state, cohort.plan.signals.length);
  const result = finaliseReplay(cohort, finished);

  writeFileSync(outPath, JSON.stringify({ pid: process.pid, result }), "utf8");
}

main();
