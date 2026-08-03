// End-to-end simulation of the manual-run "already ticked" guard.
//
// Mirrors the production path in `hourly-run.server.ts`:
//   overrideTickWindow = force || forceTick
//   sinceIso = manual ? now - RECENT_WINDOW_MS : hourStart
//   if (!(manualTrigger && overrideTickWindow)) -> look for a decision >= sinceIso
//     found -> skip "already ticked at ..."
//   otherwise -> runDailyTick
//
// Regressions this guards:
//   1. A repeat manual run inside the window still skips (no double-tick).
//   2. Force clear (`force`) OR the standalone `forceTick` parameter re-ticks.
//   3. A zero-length skip window re-ticks too (nothing can be "recent").
//   4. Cron runs are NEVER affected by either override — they keep the
//      hour-boundary guard.

import { describe, expect, it } from "vitest";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 7, 3, 13, 40, 0);
/** Production default for manual runs. */
const RECENT_WINDOW_MS = 10 * MINUTE;

type Decision = { portfolioId: string; createdAt: number };

type RunOpts = {
  triggeredBy?: "manual" | "cron";
  force?: boolean;
  forceTick?: boolean;
  /** Manual "already ticked" lookback. 0 disables the guard entirely. */
  recentWindowMs?: number;
  now?: number;
  portfolioIds: string[];
};

type RunOutcome = {
  ticked: string[];
  skipped: { id: string; reason: string }[];
};

/** The engine's tick gate, run over a set of portfolios. */
function runCycle(decisions: Decision[], opts: RunOpts): RunOutcome {
  const now = opts.now ?? NOW;
  const manualTrigger = (opts.triggeredBy ?? "manual") === "manual";
  const forceClear = opts.force === true;
  const overrideTickWindow = forceClear || opts.forceTick === true;

  const windowMs = opts.recentWindowMs ?? RECENT_WINDOW_MS;
  const hourStart = Math.floor(now / (60 * MINUTE)) * 60 * MINUTE;
  const since = manualTrigger ? now - windowMs : hourStart;

  const ticked: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const id of opts.portfolioIds) {
    if (!(manualTrigger && overrideTickWindow)) {
      const recent = decisions
        .filter((d) => d.portfolioId === id && d.createdAt >= since)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (recent) {
        skipped.push({
          id,
          reason: manualTrigger
            ? `already ticked at ${new Date(recent.createdAt).toISOString()} — enable "Force clear" (or pass forceTick:true) to override`
            : "already ticked this hour",
        });
        continue;
      }
    }
    ticked.push(id);
    decisions.push({ portfolioId: id, createdAt: now });
  }

  return { ticked, skipped };
}

const SELECTION = ["high-sim", "balanced-sim"];

/** Both selected portfolios ticked 2 minutes ago — inside the 10-min window. */
function recentlyTicked(): Decision[] {
  return SELECTION.map((id) => ({ portfolioId: id, createdAt: NOW - 2 * MINUTE }));
}

describe("manual run — Force clear / zero skip window re-ticks — e2e", () => {
  it("skips a repeat manual run inside the window by default", () => {
    const r = runCycle(recentlyTicked(), { portfolioIds: SELECTION });

    expect(r.ticked).toEqual([]);
    expect(r.skipped.map((s) => s.id)).toEqual(SELECTION);
    expect(r.skipped[0]!.reason).toContain("already ticked at");
    expect(r.skipped[0]!.reason).toContain("Force clear");
  });

  it("re-ticks when Force clear (force) is enabled", () => {
    const r = runCycle(recentlyTicked(), { portfolioIds: SELECTION, force: true });

    expect(r.ticked).toEqual(SELECTION);
    expect(r.skipped).toEqual([]);
  });

  it("re-ticks with forceTick alone — no lock eviction required", () => {
    const r = runCycle(recentlyTicked(), { portfolioIds: SELECTION, forceTick: true });

    expect(r.ticked).toEqual(SELECTION);
    expect(r.skipped).toEqual([]);
  });

  it("re-ticks when the skip window is set to zero", () => {
    const r = runCycle(recentlyTicked(), { portfolioIds: SELECTION, recentWindowMs: 0 });

    expect(r.ticked).toEqual(SELECTION);
    expect(r.skipped).toEqual([]);
  });

  it("a zero window still ticks a portfolio that ran in this very second", () => {
    const decisions: Decision[] = [{ portfolioId: "high-sim", createdAt: NOW }];
    // A decision AT `now` is >= since when the window is 10 min...
    expect(runCycle([...decisions], { portfolioIds: ["high-sim"] }).ticked).toEqual([]);
    // ...but with a zero window `since === now`, so this is a deliberate
    // override: the operator asked for an immediate re-tick.
    const r = runCycle([...decisions], { portfolioIds: ["high-sim"], recentWindowMs: 0, forceTick: true });
    expect(r.ticked).toEqual(["high-sim"]);
  });

  it("still ticks portfolios outside the window without any override", () => {
    const decisions: Decision[] = [
      { portfolioId: "high-sim", createdAt: NOW - 2 * MINUTE }, // inside
      { portfolioId: "balanced-sim", createdAt: NOW - 30 * MINUTE }, // outside
    ];
    const r = runCycle(decisions, { portfolioIds: SELECTION });

    expect(r.ticked).toEqual(["balanced-sim"]);
    expect(r.skipped.map((s) => s.id)).toEqual(["high-sim"]);
  });

  it("only re-ticks the selected portfolios when forcing", () => {
    const decisions = [
      ...recentlyTicked(),
      { portfolioId: "real", createdAt: NOW - MINUTE },
    ];
    const r = runCycle(decisions, { portfolioIds: ["high-sim"], forceTick: true });

    expect(r.ticked).toEqual(["high-sim"]);
    // "real" was never requested, so it is neither ticked nor skipped.
    expect(r.skipped).toEqual([]);
    expect(decisions.filter((d) => d.portfolioId === "real")).toHaveLength(1);
  });

  it("running twice with the override on ticks twice; without it, once", () => {
    const withOverride = recentlyTicked();
    runCycle(withOverride, { portfolioIds: ["high-sim"], forceTick: true });
    const second = runCycle(withOverride, { portfolioIds: ["high-sim"], forceTick: true });
    expect(second.ticked).toEqual(["high-sim"]);

    const plain = recentlyTicked();
    runCycle(plain, { portfolioIds: ["high-sim"] });
    const secondPlain = runCycle(plain, { portfolioIds: ["high-sim"] });
    expect(secondPlain.ticked).toEqual([]);
  });

  it("cron runs ignore force / forceTick and keep the hour guard", () => {
    // Decision already made this hour (13:05, run at 13:40).
    const decisions: Decision[] = [{ portfolioId: "high-sim", createdAt: NOW - 35 * MINUTE }];

    for (const overrides of [{}, { force: true }, { forceTick: true }, { recentWindowMs: 0 }]) {
      const r = runCycle([...decisions], {
        triggeredBy: "cron",
        portfolioIds: ["high-sim"],
        ...overrides,
      });
      expect(r.ticked).toEqual([]);
      expect(r.skipped[0]!.reason).toBe("already ticked this hour");
    }
  });

  it("cron ticks normally once the hour rolls over", () => {
    const decisions: Decision[] = [{ portfolioId: "high-sim", createdAt: NOW - 35 * MINUTE }];
    const nextHour = Date.UTC(2026, 7, 3, 14, 5, 0);

    const r = runCycle(decisions, {
      triggeredBy: "cron",
      portfolioIds: ["high-sim"],
      now: nextHour,
    });
    expect(r.ticked).toEqual(["high-sim"]);
  });
});
