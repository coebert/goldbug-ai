import { describe, expect, it, vi } from "vitest";
import {
  detectSnapshotTimingMismatches,
  logSnapshotTimingMismatches,
  SNAPSHOT_CASH_DIVERGENCE_EPSILON,
  type SnapshotMismatchInput,
} from "../snapshot-timing-mismatch";

const base = (over: Partial<SnapshotMismatchInput> = {}): SnapshotMismatchInput => ({
  portfolioId: "p1",
  portfolioName: "Live Saxo",
  mode: "live_prod",
  today: "2026-07-24",
  lastBrokerSync: { at: "2026-07-24T09:15:00Z", cash: 300 },
  latestSnapshot: { date: "2026-07-24", cash: 300, totalValue: 300 },
  ...over,
});

describe("detectSnapshotTimingMismatches", () => {
  it("returns nothing when broker sync and snapshot agree", () => {
    expect(detectSnapshotTimingMismatches([base()])).toEqual([]);
  });

  it("ignores non-live-prod portfolios entirely", () => {
    const out = detectSnapshotTimingMismatches([
      base({ mode: "paper", latestSnapshot: null }),
      base({ mode: "live_sim", latestSnapshot: null }),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores portfolios that have never been synced", () => {
    expect(
      detectSnapshotTimingMismatches([base({ lastBrokerSync: null, latestSnapshot: null })]),
    ).toEqual([]);
  });

  it("flags a live portfolio with no persisted snapshot", () => {
    const out = detectSnapshotTimingMismatches([base({ latestSnapshot: null })]);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("no-snapshot-for-broker-sync-day");
    expect(out[0].snapshotDate).toBeNull();
  });

  it("flags a stale snapshot dated before the last broker sync", () => {
    const out = detectSnapshotTimingMismatches([
      base({
        lastBrokerSync: { at: "2026-07-24T09:15:00Z", cash: 500 },
        latestSnapshot: { date: "2026-07-22", cash: 300, totalValue: 300 },
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("snapshot-older-than-broker-sync");
    expect(out[0].snapshotDate).toBe("2026-07-22");
  });

  it("flags divergence between broker cash and same-day snapshot cash", () => {
    const out = detectSnapshotTimingMismatches([
      base({
        lastBrokerSync: { at: "2026-07-24T09:15:00Z", cash: 500 },
        latestSnapshot: { date: "2026-07-24", cash: 300, totalValue: 300 },
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("snapshot-cash-diverges-from-broker");
    expect(out[0].divergence).toBe(200);
  });

  it("tolerates sub-epsilon rounding drift", () => {
    const drift = SNAPSHOT_CASH_DIVERGENCE_EPSILON / 2;
    expect(
      detectSnapshotTimingMismatches([
        base({
          lastBrokerSync: { at: "2026-07-24T09:15:00Z", cash: 300 + drift },
          latestSnapshot: { date: "2026-07-24", cash: 300, totalValue: 300 },
        }),
      ]),
    ).toEqual([]);
  });

  it("skips divergence check when snapshot cash is null (legacy row)", () => {
    expect(
      detectSnapshotTimingMismatches([
        base({ latestSnapshot: { date: "2026-07-24", cash: null, totalValue: 300 } }),
      ]),
    ).toEqual([]);
  });

  it("logs structured metadata when mismatches are present", () => {
    const err = vi.fn();
    logSnapshotTimingMismatches(
      [
        {
          portfolioId: "p1",
          portfolioName: "Live Saxo",
          reason: "snapshot-older-than-broker-sync",
          detail: "x",
          brokerSyncAt: "2026-07-24T09:15:00Z",
          brokerSyncCash: 500,
          snapshotDate: "2026-07-22",
          snapshotCash: 300,
          snapshotTotalValue: 300,
          divergence: null,
        },
      ],
      { error: err },
    );
    expect(err).toHaveBeenCalledTimes(1);
    const [msg, payload] = err.mock.calls[0];
    expect(msg).toContain("snapshot timing mismatch");
    expect(payload.count).toBe(1);
    expect(payload.mismatches[0]).toMatchObject({
      portfolioId: "p1",
      reason: "snapshot-older-than-broker-sync",
      snapshotDate: "2026-07-22",
    });
  });

  it("logs nothing when there are no mismatches", () => {
    const err = vi.fn();
    logSnapshotTimingMismatches([], { error: err });
    expect(err).not.toHaveBeenCalled();
  });
});
