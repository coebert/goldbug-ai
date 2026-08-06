// Regression: a locally recomputed valuation (backfill/revalue) must never
// overwrite a broker-authoritative snapshot for the same date. That downgrade
// is how the app ended up showing ~£64 more than the Saxo account value.

import { describe, expect, it } from "vitest";
import { writeEquitySnapshot } from "../write-snapshot.server";

type Row = { source: string; total_value: number };

function fakeClient(existing: Row | null) {
  const upserts: unknown[] = [];
  const client = {
    from(table: string) {
      if (table === "equity_snapshots") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          lt: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({ data: existing }),
          upsert: async (row: unknown) => {
            upserts.push(row);
            return { error: null };
          },
        };
        return builder;
      }
      return { insert: async () => ({ error: null }) };
    },
  };
  return { client, upserts };
}

const input = {
  portfolioId: "p1",
  snapshotDate: "2026-08-06",
  cash: 2816.41,
  holdingsValue: 7424.9,
};

describe("write gate: broker snapshots win for the same date", () => {
  it("refuses a backfill overwrite of a broker_sync row", async () => {
    const { client, upserts } = fakeClient({ source: "broker_sync", total_value: 10177.51 });
    const res = await writeEquitySnapshot(client as never, { ...input, source: "backfill" });
    expect(res.written).toBe(false);
    expect(res.reason).toBe("authoritative_exists");
    expect(upserts).toHaveLength(0);
  });

  it("refuses a revalue overwrite of a fund_event row", async () => {
    const { client, upserts } = fakeClient({ source: "fund_event", total_value: 10177.51 });
    const res = await writeEquitySnapshot(client as never, { ...input, source: "revalue" });
    expect(res.written).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("still lets broker_sync replace its own row", async () => {
    const { client, upserts } = fakeClient({ source: "broker_sync", total_value: 10177.51 });
    const res = await writeEquitySnapshot(client as never, { ...input, source: "broker_sync" });
    expect(res.written).toBe(true);
    expect(upserts).toHaveLength(1);
  });

  it("allows backfill when the stored row is not authoritative", async () => {
    const { client, upserts } = fakeClient({ source: "revalue", total_value: 10200 });
    const res = await writeEquitySnapshot(client as never, {
      ...input,
      source: "backfill",
      priorTotal: 10177.51,
    });
    expect(res.written).toBe(true);
    expect(upserts).toHaveLength(1);
  });

  it("allows backfill when no row exists yet", async () => {
    const { client, upserts } = fakeClient(null);
    const res = await writeEquitySnapshot(client as never, {
      ...input,
      source: "backfill",
      priorTotal: 10177.51,
    });
    expect(res.written).toBe(true);
    expect(upserts).toHaveLength(1);
  });
});
