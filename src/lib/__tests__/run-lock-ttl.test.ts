// Tests for run-lock TTL policy: the guarantee that a manual run which times
// out cannot leave a lock behind for longer than its TTL.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MIN_TTL_MS,
  TTL_GRACE_MS,
  clampTtl,
  effectiveExpiryMs,
  expiryFor,
  isExpired,
  lockTtlMsForBudget,
  msUntilExpiry,
} from "@/lib/run-lock-ttl";

const T0 = Date.parse("2026-08-03T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("lockTtlMsForBudget", () => {
  it("gives a manual 55s run its budget plus grace", () => {
    expect(lockTtlMsForBudget(55_000)).toBe(55_000 + TTL_GRACE_MS);
  });

  it("never returns less than the floor for tiny budgets", () => {
    expect(lockTtlMsForBudget(5_000)).toBe(MIN_TTL_MS);
  });

  it("clamps an absurd budget so a lock cannot become near-permanent", () => {
    expect(lockTtlMsForBudget(60 * 60_000)).toBe(MAX_TTL_MS);
  });

  it("falls back to the default for missing or invalid budgets", () => {
    expect(lockTtlMsForBudget(undefined)).toBe(DEFAULT_TTL_MS);
    expect(lockTtlMsForBudget(NaN)).toBe(DEFAULT_TTL_MS);
    expect(lockTtlMsForBudget(-1)).toBe(DEFAULT_TTL_MS);
  });

  it("keeps the TTL strictly longer than the run budget", () => {
    for (const budget of [24_000, 55_000, 115_000]) {
      expect(lockTtlMsForBudget(budget)).toBeGreaterThan(budget);
    }
  });
});

describe("expiryFor / clampTtl", () => {
  it("writes an absolute ISO deadline", () => {
    expect(expiryFor(T0, 75_000)).toBe(iso(T0 + 75_000));
  });

  it("clamps the ttl before computing the deadline", () => {
    expect(expiryFor(T0, 1_000)).toBe(iso(T0 + MIN_TTL_MS));
    expect(clampTtl(Infinity)).toBe(DEFAULT_TTL_MS);
  });
});

describe("isExpired", () => {
  const row = (offset: number) => ({
    acquired_at: iso(T0),
    expires_at: iso(T0 + offset),
  });

  it("a live lock is not expired", () => {
    expect(isExpired(row(75_000), T0 + 10_000)).toBe(false);
  });

  it("a lock is expired the instant its TTL lapses", () => {
    expect(isExpired(row(75_000), T0 + 75_000)).toBe(true);
    expect(isExpired(row(75_000), T0 + 75_001)).toBe(true);
  });

  it("a timed-out manual run's lock expires shortly after its budget", () => {
    // Manual run: 55s budget, worker killed at 55s without releasing.
    const ttl = lockTtlMsForBudget(55_000);
    const stranded = { acquired_at: iso(T0), expires_at: iso(T0 + ttl) };
    // Immediately after the timeout the lock is still valid (grace window)…
    expect(isExpired(stranded, T0 + 56_000)).toBe(false);
    // …but the very next cron tick a minute later can take it.
    expect(isExpired(stranded, T0 + 120_000)).toBe(true);
  });

  it("legacy rows with no expires_at fall back to acquired_at + window", () => {
    const legacy = { acquired_at: iso(T0), expires_at: null };
    expect(isExpired(legacy, T0 + 30_000, 90_000)).toBe(false);
    expect(isExpired(legacy, T0 + 120_000, 90_000)).toBe(true);
  });

  it("treats an unparseable acquired_at as expired rather than permanent", () => {
    expect(isExpired({ acquired_at: "not-a-date", expires_at: null }, T0)).toBe(true);
  });

  it("a heartbeat that pushes expires_at forward keeps the lock alive", () => {
    let r = { acquired_at: iso(T0), expires_at: expiryFor(T0, 75_000) };
    for (let beat = 1; beat <= 10; beat++) {
      const now = T0 + beat * 30_000;
      expect(isExpired(r, now)).toBe(false);
      r = { acquired_at: iso(now), expires_at: expiryFor(now, 75_000) };
    }
    // Heartbeats stop (isolate died) — the lock frees itself.
    expect(isExpired(r, T0 + 10 * 30_000 + 76_000)).toBe(true);
  });
});

describe("msUntilExpiry", () => {
  it("counts down and goes negative past the deadline", () => {
    const r = { acquired_at: iso(T0), expires_at: iso(T0 + 75_000) };
    expect(msUntilExpiry(r, T0 + 25_000)).toBe(50_000);
    expect(msUntilExpiry(r, T0 + 90_000)).toBe(-15_000);
  });

  it("effectiveExpiryMs prefers the explicit TTL over the fallback", () => {
    const r = { acquired_at: iso(T0), expires_at: iso(T0 + 300_000) };
    expect(effectiveExpiryMs(r, 90_000)).toBe(T0 + 300_000);
  });
});
