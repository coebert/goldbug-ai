import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEE_SYNC_STATUSES } from "@/lib/fee-sync-status";
import { mapSaxoChargeRows } from "@/lib/brokers/saxo-charges";
import fixtures from "@/lib/brokers/__tests__/fixtures/saxo-charge-reports.json";

/**
 * The unit-mismatch path, end to end against the real server ingest.
 *
 * This is the bug this test exists for: the gate held a pence-as-pounds
 * charge, wrote `fee_sync_status: "unit_mismatch"`, the database CHECK
 * constraint rejected the value, and the error was dropped on the floor — so
 * the fill kept its previous status and looked normally synced while its real
 * charge had been blocked. Here the fake tape enforces the same constraint,
 * so a status the column cannot hold fails the test instead of going quiet,
 * and a later corrected restatement must actually save the fee.
 */

type Row = Record<string, unknown>;

const CHECK_CONSTRAINT = new Set<string>(FEE_SYNC_STATUSES);

const fillsTable: Row[] = [];
const writes: Array<{ id: string; patch: Row }> = [];
const errors: string[] = [];

vi.mock("@/lib/_server/log", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: (msg: string, meta?: unknown) => errors.push(`${msg} ${JSON.stringify(meta ?? {})}`),
    debug: () => {},
  }),
}));

vi.mock("@/lib/fx.server", () => ({
  convertAmount: async (amount: number) => ({ amount }),
}));

function applyUpdate(patch: Row, ids: string[]) {
  const status = patch["fee_sync_status"];
  // Stand-in for the live CHECK constraint on live_fills.fee_sync_status.
  if (typeof status === "string" && !CHECK_CONSTRAINT.has(status)) {
    return {
      error: {
        message: `new row violates check constraint "live_fills_fee_sync_status_check" (${status})`,
      },
    };
  }
  for (const id of ids) {
    const row = fillsTable.find((r) => r["id"] === id);
    if (!row) continue;
    Object.assign(row, patch);
    writes.push({ id, patch: { ...patch } });
  }
  return { error: null };
}

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => ({
    select: () => {
      const q = {
        eq: () => q,
        gte: () => q,
        in: () => q,
        order: () => q,
        limit: () => Promise.resolve({ data: table === "live_fills" ? fillsTable : [], error: null }),
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: table === "live_fills" ? fillsTable : [], error: null }).then(res),
      };
      return q;
    },
    update: (patch: Row) => ({
      eq: (_c: string, id: string) => Promise.resolve(applyUpdate(patch, [id])),
      in: (_c: string, ids: string[]) => Promise.resolve(applyUpdate(patch, ids)),
    }),
  });
  return { supabaseAdmin: { from } };
});

const { ingestBrokerCostsForPortfolio } = await import("@/lib/broker-cost-ingest.server");

const report = fixtures as unknown as Record<string, Row[]>;
const NOW = new Date("2026-08-24T18:00:00Z");

/** LLOY: 500 @ £0.62 = £310 notional, with a £900 "commission" — pence, mislabelled. */
function seedLloyFill(overrides: Row = {}) {
  fillsTable.length = 0;
  fillsTable.push({
    id: "fill-lloy",
    order_id: null,
    portfolio_id: "pf-1",
    symbol: "LLOY.L",
    side: "buy",
    quantity: 500,
    fill_price: 0.62,
    currency: "GBP",
    filled_at: "2026-08-17T09:00:00Z",
    broker_fill_id: "5000000005",
    broker_trade_id: null,
    fee: 1.85,
    fee_source: "model",
    fee_sync_status: "pending",
    fee_sync_reason: null,
    ...overrides,
  });
}

const adapterFor = (rows: Row[]) => ({
  getTradeCharges: async () => ({ supported: true, charges: mapSaxoChargeRows(rows) }),
});

const run = (rows: Row[]) =>
  ingestBrokerCostsForPortfolio({
    portfolioId: "pf-1",
    userId: "u-1",
    adapter: adapterFor(rows) as never,
    now: NOW,
  });

beforeEach(() => {
  writes.length = 0;
  errors.length = 0;
});

describe("unit mismatch, end to end through the server ingest", () => {
  it("records the hold with a status the column actually accepts", async () => {
    seedLloyFill();
    const res = await run(report["penceAsPoundsRow"]!);

    expect(res.unitMismatches).toBe(1);
    expect(res.fillsUpdated).toBe(0);

    const row = fillsTable[0]!;
    expect(row["fee_sync_status"]).toBe("unit_mismatch");
    expect(String(row["fee_sync_reason"])).toBeTruthy();
    expect(row["fee_sync_attempted_at"]).toBe(NOW.toISOString());
    // The constraint stand-in never fired, and nothing was swallowed.
    expect(errors).toEqual([]);
  });

  it("never lets the bad charge reach the tape, and never claims it was invoiced", async () => {
    seedLloyFill();
    await run(report["penceAsPoundsRow"]!);

    const row = fillsTable[0]!;
    expect(row["fee"]).toBe(1.85); // modelled fee left intact
    expect(row["fee_source"]).toBe("model");
    expect(row["fee_synced_at"]).toBeUndefined();
    for (const w of writes) {
      expect(w.patch).not.toHaveProperty("fee");
      expect(w.patch["fee_sync_status"]).not.toBe("invoiced");
    }
    // The broker trade id is still stamped, so the restatement re-matches.
    expect(row["broker_trade_id"]).toBe("9000000005");
  });

  it("does not leave a previously invoiced fill looking normally synced", async () => {
    seedLloyFill({ fee: 4.2, fee_source: "broker", fee_sync_status: "invoiced" });
    await run(report["penceAsPoundsRow"]!);
    expect(fillsTable[0]!["fee_sync_status"]).toBe("unit_mismatch");
  });

  it("surfaces the failure loudly if the database rejects the hold", async () => {
    seedLloyFill();
    // Simulate the pre-fix constraint, which did not know `unit_mismatch`.
    CHECK_CONSTRAINT.delete("unit_mismatch");
    try {
      await run(report["penceAsPoundsRow"]!);
    } finally {
      CHECK_CONSTRAINT.add("unit_mismatch");
    }
    expect(errors.join("\n")).toMatch(/failed to record unit-mismatch hold/);
    expect(errors.join("\n")).toMatch(/check constraint/);
  });

  it("saves the correct fee once the broker restates the charge in pounds", async () => {
    seedLloyFill();
    await run(report["penceAsPoundsRow"]!);
    expect(fillsTable[0]!["fee_sync_status"]).toBe("unit_mismatch");

    const restated = [{ ...report["penceAsPoundsRow"]![0]!, Commission: 9 }];
    const res = await run(restated);

    expect(res.fillsUpdated).toBe(1);
    expect(res.unitMismatches).toBe(0);
    const row = fillsTable[0]!;
    expect(row["fee"]).toBeCloseTo(9, 6);
    expect(row["fee_commission"]).toBeCloseTo(9, 6);
    expect(row["fee_source"]).toBe("broker");
    expect(row["fee_sync_status"]).toBe("invoiced");
    expect(row["fee_sync_reason"]).toBeNull();
    expect(row["fee_synced_at"]).toBe(NOW.toISOString());
  });
});
