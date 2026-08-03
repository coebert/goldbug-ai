import { describe, expect, it } from "vitest";

import { writeEquitySnapshot } from "../write-snapshot.server";

function fakeClient() {
  const upserts: unknown[] = [];
  const rejections: unknown[] = [];
  const client = {
    from(table: string) {
      if (table === "equity_snapshots") {
        return {
          upsert: (row: unknown) => {
            upserts.push(row);
            return Promise.resolve({ error: null });
          },
          select: () => ({
            eq: () => ({
              lt: () => ({
                order: () => ({
                  limit: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        insert: (row: unknown) => {
          rejections.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, upserts, rejections };
}

describe("write gate: broker-linked portfolio with no imported positions", () => {
  it("refuses a cash-only snapshot when the book has not been synced", async () => {
    const { client, upserts, rejections } = fakeClient();
    const res = await writeEquitySnapshot(client as never, {
      portfolioId: "p1",
      snapshotDate: "2026-07-23",
      cash: 1300.32,
      holdingsValue: 0,
      source: "trading_engine",
      brokerLinked: true,
      positionCount: 0,
    });
    expect(res.written).toBe(false);
    expect(res.reason).toBe("unsynced_positions");
    expect(upserts).toHaveLength(0);
    expect(rejections).toHaveLength(1);
  });

  it("allows a genuinely flat, non-broker portfolio", async () => {
    const { client, upserts } = fakeClient();
    const res = await writeEquitySnapshot(client as never, {
      portfolioId: "p2",
      snapshotDate: "2026-07-23",
      cash: 1300.32,
      holdingsValue: 0,
      source: "trading_engine",
      brokerLinked: false,
      positionCount: 0,
    });
    expect(res.written).toBe(true);
    expect(upserts).toHaveLength(1);
  });

  it("allows a broker-linked portfolio once positions exist", async () => {
    const { client, upserts } = fakeClient();
    const res = await writeEquitySnapshot(client as never, {
      portfolioId: "p3",
      snapshotDate: "2026-07-24",
      cash: 1300.32,
      holdingsValue: 8888.8,
      source: "trading_engine",
      brokerLinked: true,
      positionCount: 4,
    });
    expect(res.written).toBe(true);
    expect(upserts).toHaveLength(1);
  });
});
