import { describe, expect, it } from "vitest";

import {
  auditFeeDrag,
  assertFeeDragMatchesFills,
  fillsFromTradeLog,
  formatFeeDragAudit,
  FEE_DRAG_TOLERANCE_PCT,
  type AuditableFill,
} from "@/lib/fee-drag-audit";
import {
  estimateFeeDrag,
  totalFeeDragPct,
  type FeeDragFrictions,
} from "@/lib/fee-drag-objective";

const FRICTIONS: FeeDragFrictions = {
  commissionBps: 10,
  minCommission: 3,
  slippageBps: 8,
  buyTaxBps: 50, // UK stamp duty on buys
};

const START = 10_300;

/** A deterministic, realistic mixed-size fill tape. */
function tape(): AuditableFill[] {
  const rows: AuditableFill[] = [];
  for (let i = 0; i < 24; i++) {
    const side = i % 2 === 0 ? ("buy" as const) : ("sell" as const);
    // Alternate small tickets (below the commission floor) with large ones.
    const notional = i % 4 === 0 ? 420 : 2_600;
    const quantity = i % 4 === 0 ? 12 : 40;
    const price = notional / quantity;
    const rate = notional * (FRICTIONS.commissionBps! / 10_000);
    const tax = side === "buy" ? notional * (FRICTIONS.buyTaxBps! / 10_000) : 0;
    rows.push({
      side,
      quantity,
      price,
      fee: Math.max(FRICTIONS.minCommission!, rate) + tax,
    });
  }
  return rows;
}

const reportedFor = (rows: AuditableFill[]) =>
  estimateFeeDrag(fillsFromTradeLog(rows), FRICTIONS, START);

const headlineFor = (rows: AuditableFill[]) =>
  (rows.reduce((s, r) => s + (r.fee ?? 0), 0) / START) * 100;

describe("fee-drag audit: reconstruction from executed fills", () => {
  it("reconciles every component against the reported breakdown", () => {
    const rows = tape();
    const audit = auditFeeDrag({
      rows,
      frictions: FRICTIONS,
      startingCash: START,
      reported: reportedFor(rows),
      reportedFeeDragPct: headlineFor(rows),
    });

    expect(audit.ok).toBe(true);
    expect(audit.issues).toEqual([]);
    expect(audit.fills).toBe(rows.length);
    expect(audit.deltas.commissionPct).toBeLessThanOrEqual(FEE_DRAG_TOLERANCE_PCT);
    expect(audit.deltas.minFeePct).toBeLessThanOrEqual(FEE_DRAG_TOLERANCE_PCT);
    expect(audit.deltas.slippagePct).toBeLessThanOrEqual(FEE_DRAG_TOLERANCE_PCT);
    expect(audit.deltas.otherPct).toBeLessThanOrEqual(FEE_DRAG_TOLERANCE_PCT);
    expect(audit.deltas.bookedFeePct).toBeLessThanOrEqual(FEE_DRAG_TOLERANCE_PCT);
    expect(formatFeeDragAudit(audit)).toContain("reconciles");
  });

  it("recovers non-zero commission, min fees, slippage and taxes", () => {
    const rows = tape();
    const b = reportedFor(rows);
    expect(b.commissionPct).toBeGreaterThan(0);
    expect(b.minFeePct).toBeGreaterThan(0); // the £420 tickets hit the floor
    expect(b.slippagePct).toBeGreaterThan(0);
    expect(b.otherPct).toBeGreaterThan(0); // stamp duty on buys
    expect(b.minFeePct).toBeLessThanOrEqual(b.commissionPct);
    expect(totalFeeDragPct(b)).toBeCloseTo(
      b.commissionPct + b.slippagePct + b.otherPct,
      12,
    );
  });

  it("normalises upper/lower-case sides and drops zero-quantity rows", () => {
    const rows: AuditableFill[] = [
      { side: "BUY", quantity: 10, price: 100, fee: 5 },
      { side: "SELL", quantity: 10, price: 101, fee: 3 },
      { side: "buy", quantity: 0, price: 100, fee: 99 },
    ];
    const fills = fillsFromTradeLog(rows);
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ side: "BUY", notional: 1_000, fee: 5 });
    expect(fills[1]!.side).toBe("SELL");
  });
});

describe("fee-drag audit: mismatch detection", () => {
  const rows = tape();

  it("flags an understated commission component", () => {
    const reported = { ...reportedFor(rows), commissionPct: reportedFor(rows).commissionPct * 0.5 };
    const audit = auditFeeDrag({ rows, frictions: FRICTIONS, startingCash: START, reported });
    expect(audit.ok).toBe(false);
    expect(audit.issues.join(" ")).toContain("commission");
  });

  it("flags slippage/impact that was silently zeroed out", () => {
    const reported = { ...reportedFor(rows), slippagePct: 0 };
    const audit = auditFeeDrag({ rows, frictions: FRICTIONS, startingCash: START, reported });
    expect(audit.ok).toBe(false);
    expect(audit.issues.join(" ")).toContain("slippage/impact");
  });

  it("flags missing FX/tax attribution", () => {
    const reported = { ...reportedFor(rows), otherPct: 0 };
    const audit = auditFeeDrag({ rows, frictions: FRICTIONS, startingCash: START, reported });
    expect(audit.ok).toBe(false);
    expect(audit.issues.join(" ")).toContain("fx/taxes");
  });

  it("flags min fees claimed larger than the commission they sit inside", () => {
    const base = reportedFor(rows);
    const reported = { ...base, minFeePct: base.commissionPct * 2 };
    const audit = auditFeeDrag({ rows, frictions: FRICTIONS, startingCash: START, reported });
    expect(audit.ok).toBe(false);
    expect(audit.issues.join(" ")).toMatch(/min fees/);
  });

  it("flags a trade log that lost fills relative to the reported drag", () => {
    const reported = reportedFor(rows);
    const audit = auditFeeDrag({
      rows: rows.slice(0, 6),
      frictions: FRICTIONS,
      startingCash: START,
      reported,
      reportedFeeDragPct: headlineFor(rows),
    });
    expect(audit.ok).toBe(false);
    expect(audit.fills).toBe(6);
    expect(audit.issues.length).toBeGreaterThan(1);
  });

  it("flags a headline feeDragPct that disagrees with booked fees", () => {
    const reported = reportedFor(rows);
    const audit = auditFeeDrag({
      rows,
      frictions: FRICTIONS,
      startingCash: START,
      reported,
      reportedFeeDragPct: headlineFor(rows) + 0.5,
    });
    expect(audit.ok).toBe(false);
    expect(audit.issues.join(" ")).toContain("headline feeDragPct");
  });

  it("catches notionals booked in the wrong price unit (GBX vs GBP)", () => {
    const gbx = rows.map((r) => ({ ...r, price: r.price * 100 }));
    const audit = auditFeeDrag({
      rows: gbx,
      frictions: FRICTIONS,
      startingCash: START,
      reported: reportedFor(rows),
    });
    expect(audit.ok).toBe(false);
    // 100x notionals inflate the reconstructed slippage and shrink min-fee share.
    expect(audit.deltas.slippagePct).toBeGreaterThan(1);
  });

  it("assertFeeDragMatchesFills throws on drift and returns the audit when clean", () => {
    expect(() =>
      assertFeeDragMatchesFills({
        rows,
        frictions: FRICTIONS,
        startingCash: START,
        reported: { ...reportedFor(rows), commissionPct: 0 },
      }),
    ).toThrow(/fee drag MISMATCH/);

    const ok = assertFeeDragMatchesFills({
      rows,
      frictions: FRICTIONS,
      startingCash: START,
      reported: reportedFor(rows),
    });
    expect(ok.ok).toBe(true);
  });

  it("is inert on an empty tape and on a zero starting balance", () => {
    expect(
      auditFeeDrag({ rows: [], frictions: FRICTIONS, startingCash: START, reported: reportedFor([]) })
        .ok,
    ).toBe(true);
    expect(
      auditFeeDrag({ rows, frictions: FRICTIONS, startingCash: 0, reported: reportedFor([]) }).ok,
    ).toBe(true);
  });
});
