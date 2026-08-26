import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/saxo-charge-reports.json";
import { mapSaxoChargeRows } from "@/lib/brokers/saxo-charges";
import {
  convertChargeLegs,
  matchChargesToFills,
  brokerCoverage,
  type IngestFill,
} from "@/lib/broker-cost-ingest";
import { checkChargeUnits } from "@/lib/valuation/unit-validation";

/**
 * End-to-end over the pure half of broker cost ingestion: real (anonymised)
 * Saxo report payloads → mapper → fill matcher → unit gate → leg conversion →
 * the `fee_source` / `fee_sync_status` the server would write.
 *
 * The unit tests next door pin single-row mapping. This pins the thing that
 * actually went wrong in production: a row maps "fine" but the tape ends up
 * claiming the broker billed £0, so the friction KPI reads free trading.
 */

type Report = Record<string, Record<string, unknown>[]>;
const report = fixtures as unknown as Report;

/** Mirrors the decision table in `broker-cost-ingest.server.ts`. */
type Outcome = {
  fillId: string;
  feeSource: "broker" | "model" | "none";
  feeSyncStatus: "invoiced" | "pending" | "unmatched" | "unit_mismatch";
  fee: number;
  legs?: { commission: number; exchangeFee: number; tax: number; other: number; total: number };
};

async function ingest(fills: IngestFill[], rows: unknown[]): Promise<Outcome[]> {
  const charges = mapSaxoChargeRows(rows);
  const { updates, unmatchedFillIds } = matchChargesToFills({ fills, charges });
  const out: Outcome[] = [];

  for (const u of updates) {
    const fill = fills.find((f) => f.id === u.fillId)!;
    const check = checkChargeUnits({
      id: fill.id,
      symbol: fill.symbol,
      quantity: fill.quantity,
      fillPrice: fill.fillPrice,
      fillCurrency: fill.currency,
      chargeTotal: u.total,
      chargeCurrency: u.currency,
    });
    if (check.blocked) {
      out.push({
        fillId: fill.id,
        feeSource: (fill.feeSource as Outcome["feeSource"]) ?? "model",
        feeSyncStatus: "unit_mismatch",
        fee: 0,
      });
      continue;
    }
    const legs = await convertChargeLegs(u, fill.currency || "GBP", async (a) => a);
    if (!(legs.total > 0)) {
      out.push({
        fillId: fill.id,
        // A zero invoice is "not billed yet", never "billed nothing".
        feeSource: fill.feeSource === "broker" ? "none" : ((fill.feeSource as Outcome["feeSource"]) ?? "model"),
        feeSyncStatus: "pending",
        fee: 0,
      });
      continue;
    }
    out.push({ fillId: fill.id, feeSource: "broker", feeSyncStatus: "invoiced", fee: legs.total, legs });
  }

  for (const id of unmatchedFillIds) {
    const fill = fills.find((f) => f.id === id)!;
    out.push({
      fillId: id,
      feeSource: (fill.feeSource as Outcome["feeSource"]) ?? "model",
      feeSyncStatus: "unmatched",
      fee: 0,
    });
  }
  return out;
}

const fill = (o: Partial<IngestFill> & Pick<IngestFill, "id" | "symbol">): IngestFill => ({
  side: "buy",
  quantity: 1,
  fillPrice: 1,
  currency: "GBP",
  filledAt: "2026-08-21T09:32:00Z",
  brokerFillId: null,
  brokerTradeId: null,
  feeSource: "model",
  ...o,
});

describe("saxo charge report fixtures — ingestion end to end", () => {
  it("invoices an LSE trades report row and keeps legs summing to the total", async () => {
    const fills = [
      fill({
        id: "f-bp",
        symbol: "BP.L",
        quantity: 154,
        fillPrice: 5.5,
        brokerFillId: "5000000001",
        filledAt: "2026-08-21T09:32:11Z",
      }),
    ];
    const [o] = await ingest(fills, report["tradesReportLse"]!.slice(0, 1));
    expect(o).toMatchObject({ feeSource: "broker", feeSyncStatus: "invoiced" });
    expect(o!.fee).toBeCloseTo(12.24, 6);
    const legs = o!.legs!;
    expect(legs.commission + legs.exchangeFee + legs.tax + legs.other).toBeCloseTo(legs.total, 9);
  });

  it("rescales a GBp-denominated charge into pounds instead of billing 100x", async () => {
    const fills = [
      fill({
        id: "f-vod",
        symbol: "VOD.L",
        side: "sell",
        quantity: 400,
        fillPrice: 0.72,
        brokerFillId: "5000000002",
        filledAt: "2026-08-21T14:02:40Z",
      }),
    ];
    const [o] = await ingest(fills, report["tradesReportLse"]!.slice(1));
    expect(o!.feeSyncStatus).toBe("invoiced");
    expect(o!.fee).toBeCloseTo(9, 6);
    expect(o!.legs!.commission).toBeCloseTo(8, 6);
    expect(o!.legs!.tax).toBeCloseTo(1, 6);
  });

  it("matches an activities-report row on attributes and sums nested cost blocks", async () => {
    const fills = [
      fill({
        id: "f-aapl",
        symbol: "AAPL:xnas",
        quantity: 12,
        fillPrice: 214.35,
        currency: "USD",
        filledAt: "2026-08-20T15:41:05Z",
      }),
    ];
    const [o] = await ingest(fills, report["activitiesReportUs"]!);
    expect(o).toMatchObject({ feeSource: "broker", feeSyncStatus: "invoiced" });
    expect(o!.fee).toBeCloseTo(5.43, 6);
  });

  it("still bills a schema whose charge columns we never enumerated", async () => {
    const fills = [
      fill({
        id: "f-shel",
        symbol: "SHEL.L",
        quantity: 60,
        fillPrice: 27.4,
        filledAt: "2026-08-19T12:00:00Z",
      }),
    ];
    const [o] = await ingest(fills, report["unknownSchemaRow"]!);
    expect(o!.feeSyncStatus).toBe("invoiced");
    expect(o!.fee).toBeCloseTo(5, 6);
  });

  it("never lets a zero invoice stand as broker-authoritative", async () => {
    const fills = [
      fill({
        id: "f-mks",
        symbol: "MKS.L",
        side: "sell",
        quantity: 200,
        fillPrice: 3.11,
        brokerFillId: "5000000003",
        filledAt: "2026-08-22T10:05:00Z",
        feeSource: "broker",
      }),
    ];
    const [o] = await ingest(fills, report["zeroChargeRow"]!);
    expect(o).toMatchObject({ feeSource: "none", feeSyncStatus: "pending", fee: 0 });
  });

  it("holds a pence-as-pounds charge rather than writing it to the tape", async () => {
    const fills = [
      fill({
        id: "f-lloy",
        symbol: "LLOY.L",
        quantity: 500,
        fillPrice: 0.62,
        brokerFillId: "5000000005",
        filledAt: "2026-08-17T09:00:00Z",
      }),
    ];
    const [o] = await ingest(fills, report["penceAsPoundsRow"]!);
    expect(o).toMatchObject({ feeSource: "model", feeSyncStatus: "unit_mismatch", fee: 0 });
  });

  it("charges a restated duplicate row once", async () => {
    const fills = [
      fill({
        id: "f-glen",
        symbol: "GLEN.L",
        quantity: 300,
        fillPrice: 3.4,
        brokerFillId: "5000000004",
        filledAt: "2026-08-18T08:15:00Z",
      }),
    ];
    const outcomes = await ingest(fills, report["duplicatedRestatement"]!);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.fee).toBeCloseTo(6, 6);
  });

  it("keeps fee_source consistent across a whole mixed report", async () => {
    const fills = [
      fill({ id: "f-bp", symbol: "BP.L", quantity: 154, fillPrice: 5.5, brokerFillId: "5000000001", filledAt: "2026-08-21T09:32:11Z" }),
      fill({ id: "f-mks", symbol: "MKS.L", side: "sell", quantity: 200, fillPrice: 3.11, brokerFillId: "5000000003", filledAt: "2026-08-22T10:05:00Z", feeSource: "broker" }),
      fill({ id: "f-lloy", symbol: "LLOY.L", quantity: 500, fillPrice: 0.62, brokerFillId: "5000000005", filledAt: "2026-08-17T09:00:00Z" }),
      fill({ id: "f-orphan", symbol: "RIO.L", quantity: 10, fillPrice: 45, filledAt: "2026-08-15T09:00:00Z" }),
    ];
    const rows = [
      ...report["tradesReportLse"]!.slice(0, 1),
      ...report["zeroChargeRow"]!,
      ...report["penceAsPoundsRow"]!,
    ];
    const outcomes = await ingest(fills, rows);
    const byId = Object.fromEntries(outcomes.map((o) => [o.fillId, o]));

    // Only the row that actually carried money may claim broker authority.
    expect(outcomes.filter((o) => o.feeSource === "broker").map((o) => o.fillId)).toEqual(["f-bp"]);
    for (const o of outcomes) {
      expect(o.feeSource === "broker").toBe(o.fee > 0);
      expect(o.feeSource === "broker").toBe(o.feeSyncStatus === "invoiced");
    }
    expect(byId["f-orphan"]!.feeSyncStatus).toBe("unmatched");

    // Coverage is the KPI denominator: it must count only invoiced rows.
    expect(
      brokerCoverage(outcomes.map((o) => ({ feeSource: o.feeSource }))),
    ).toBeCloseTo(0.25, 6);
  });
});
