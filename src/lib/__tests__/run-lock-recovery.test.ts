import { describe, it, expect, beforeEach } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  MIN_CONTENTION_OBSERVATIONS,
  RECOVERY_WINDOW_MS,
  recordContention,
  shouldForceRecover,
  noteContention,
  getContention,
  clearContention,
  resetContentionRegistry,
  type ContentionState,
} from "@/lib/run-lock-recovery";

const NAME = "hourly-run";
const T0 = Date.UTC(2026, 7, 3, 8, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** Simulate n contended acquire attempts spaced `every` ms against a lock row. */
function observe(opts: {
  attempts: number;
  every: number;
  /** Returns the acquired_at the row reports at the given observation time. */
  acquiredAtAt: (observedAt: number) => number;
  startAt?: number;
}): { state: ContentionState; lastObservedAt: number } {
  let state: ContentionState | null = null;
  let t = opts.startAt ?? T0;
  for (let i = 0; i < opts.attempts; i++) {
    state = recordContention(state, {
      name: NAME,
      acquiredAt: iso(opts.acquiredAtAt(t)),
      heldBy: "cron",
      observedAt: t,
    });
    if (i < opts.attempts - 1) t += opts.every;
  }
  return { state: state!, lastObservedAt: t };
}

describe("run-lock recovery: contention folding", () => {
  it("starts a fresh window on first observation", () => {
    const s = recordContention(null, { name: NAME, acquiredAt: iso(T0), observedAt: T0 });
    expect(s.observations).toBe(1);
    expect(s.firstObservedAt).toBe(T0);
    expect(s.lastObservedAt).toBe(T0);
  });

  it("accumulates observations while acquired_at is frozen", () => {
    const { state } = observe({ attempts: 4, every: 30_000, acquiredAtAt: () => T0 - 60_000 });
    expect(state.observations).toBe(4);
    expect(state.lastObservedAt - state.firstObservedAt).toBe(90_000);
  });

  it("resets the window when the holder heartbeats acquired_at forward", () => {
    // Holder renews every 30s → acquired_at always ~5s old at observation time.
    const { state } = observe({ attempts: 6, every: 30_000, acquiredAtAt: (t) => t - 5_000 });
    expect(state.observations).toBe(1);
  });

  it("resets when the lock name changes", () => {
    const a = recordContention(null, { name: NAME, acquiredAt: iso(T0), observedAt: T0 });
    const b = recordContention(a, { name: "batch-retrain", acquiredAt: iso(T0), observedAt: T0 + 1000 });
    expect(b.observations).toBe(1);
    expect(b.name).toBe("batch-retrain");
  });

  it("resets on clock regression rather than trusting a stale window", () => {
    const a = recordContention(null, { name: NAME, acquiredAt: iso(T0), observedAt: T0 + 100_000 });
    const b = recordContention(a, { name: NAME, acquiredAt: iso(T0), observedAt: T0 + 1_000 });
    expect(b.observations).toBe(1);
  });
});

describe("run-lock recovery: eviction decision", () => {
  it("never recovers with no observed state", () => {
    const d = shouldForceRecover(null, { now: T0 });
    expect(d.recover).toBe(false);
    expect(d.reason).toBe("no-state");
  });

  it("never recovers on a single contended attempt", () => {
    const { state } = observe({ attempts: 1, every: 0, acquiredAtAt: () => T0 - 10 * 60_000 });
    const d = shouldForceRecover(state, { now: T0 });
    expect(d.recover).toBe(false);
    expect(d.reason).toBe("too-few-observations");
  });

  it("never recovers before the window spans two heartbeats", () => {
    // 3 observations, but only 20s apart → 40s span < 75s window.
    const { state, lastObservedAt } = observe({
      attempts: MIN_CONTENTION_OBSERVATIONS,
      every: 20_000,
      acquiredAtAt: () => T0 - 10 * 60_000,
    });
    const d = shouldForceRecover(state, { now: lastObservedAt });
    expect(d.recover).toBe(false);
    expect(d.reason).toBe("window-too-short");
  });

  it("never evicts an active run that heartbeats", () => {
    // 20 contended attempts over 10 minutes against a healthy, renewing holder.
    const { state, lastObservedAt } = observe({
      attempts: 20,
      every: 30_000,
      acquiredAtAt: (t) => t - 5_000,
    });
    const d = shouldForceRecover(state, { now: lastObservedAt });
    expect(d.recover).toBe(false);
    expect(state.observations).toBe(1);
  });

  it("does not recover if the row itself is younger than the recovery window", () => {
    const frozen = T0 - 10_000; // 10s old row
    const state: ContentionState = {
      name: NAME,
      acquiredAt: iso(frozen),
      heldBy: "cron",
      firstObservedAt: T0 - RECOVERY_WINDOW_MS - 5_000,
      lastObservedAt: T0,
      observations: 5,
    };
    const d = shouldForceRecover(state, { now: T0 });
    expect(d.recover).toBe(false);
    expect(d.reason).toBe("holder-heartbeating");
  });

  it("recovers a frozen lock after repeated contention", () => {
    const frozen = T0 - 5 * 60_000;
    const { state, lastObservedAt } = observe({
      attempts: 4,
      every: HEARTBEAT_INTERVAL_MS,
      acquiredAtAt: () => frozen,
    });
    const d = shouldForceRecover(state, { now: lastObservedAt });
    expect(d.recover).toBe(true);
    expect(d.reason).toBe("stale-lock-confirmed");
    expect(d.observations).toBe(4);
    expect(d.observedForMs).toBeGreaterThanOrEqual(RECOVERY_WINDOW_MS);
  });

  it("recovers exactly at the threshold, not before it", () => {
    const frozen = T0 - 10 * 60_000;
    let state: ContentionState | null = null;
    let t = T0;
    const decisions: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      state = recordContention(state, { name: NAME, acquiredAt: iso(frozen), observedAt: t });
      decisions.push(shouldForceRecover(state, { now: t }).recover);
      t += HEARTBEAT_INTERVAL_MS;
    }
    // 1st (0s), 2nd (30s), 3rd (60s) all below the 75s window; 4th (90s) trips.
    expect(decisions).toEqual([false, false, false, true, true]);
  });

  it("a late heartbeat mid-window defers recovery again", () => {
    const frozen = T0 - 10 * 60_000;
    let state = recordContention(null, { name: NAME, acquiredAt: iso(frozen), observedAt: T0 });
    state = recordContention(state, { name: NAME, acquiredAt: iso(frozen), observedAt: T0 + 30_000 });
    state = recordContention(state, { name: NAME, acquiredAt: iso(frozen), observedAt: T0 + 60_000 });
    // Holder wakes up and renews.
    const renewed = T0 + 85_000;
    state = recordContention(state, { name: NAME, acquiredAt: iso(renewed), observedAt: T0 + 90_000 });
    expect(shouldForceRecover(state, { now: T0 + 90_000 }).recover).toBe(false);
  });

  it("tolerates a corrupt acquired_at without evicting", () => {
    const state: ContentionState = {
      name: NAME,
      acquiredAt: "not-a-date",
      heldBy: null,
      firstObservedAt: T0,
      lastObservedAt: T0 + RECOVERY_WINDOW_MS + 1,
      observations: 5,
    };
    expect(shouldForceRecover(state, { now: T0 }).recover).toBe(false);
  });
});

describe("run-lock recovery: registry lifecycle", () => {
  beforeEach(() => resetContentionRegistry());

  it("accumulates per lock name independently", () => {
    noteContention({ name: NAME, acquiredAt: iso(T0), observedAt: T0 });
    noteContention({ name: NAME, acquiredAt: iso(T0), observedAt: T0 + 30_000 });
    noteContention({ name: "batch-retrain", acquiredAt: iso(T0), observedAt: T0 });
    expect(getContention(NAME)?.observations).toBe(2);
    expect(getContention("batch-retrain")?.observations).toBe(1);
  });

  it("clears state once the lock is acquired or released", () => {
    noteContention({ name: NAME, acquiredAt: iso(T0), observedAt: T0 });
    clearContention(NAME);
    expect(getContention(NAME)).toBeNull();
    expect(shouldForceRecover(getContention(NAME), { now: T0 }).recover).toBe(false);
  });

  it("a cold isolate cannot evict immediately — it must re-observe", () => {
    const frozen = T0 - 60 * 60_000; // an hour-old wedged lock
    resetContentionRegistry(); // simulates fresh worker
    const first = noteContention({ name: NAME, acquiredAt: iso(frozen), observedAt: T0 });
    expect(shouldForceRecover(first, { now: T0 }).recover).toBe(false);
    noteContention({ name: NAME, acquiredAt: iso(frozen), observedAt: T0 + 40_000 });
    const third = noteContention({ name: NAME, acquiredAt: iso(frozen), observedAt: T0 + 80_000 });
    expect(shouldForceRecover(third, { now: T0 + 80_000 }).recover).toBe(true);
  });
});
