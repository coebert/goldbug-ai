import { describe, expect, it } from "vitest";
import { computeThesisBreakImpact } from "../thesis-break-impact";
import type { ArmResult } from "../thesis-break-replay";

const arm = (o: Partial<ArmResult>): ArmResult => ({
  arm: "stop-only" as ArmResult["arm"],
  equity: [],
  totalReturnPct: 0,
  maxDrawdownPct: 0,
  winRatePct: 0,
  avgLossPct: 0,
  trades: [],
  exitMix: {},
  thesisEvents: [],
  signalCounts: {},
  actionMix: { trim: 0, close: 0 },
  ...o,
});

const evented = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ date: `2026-0${(i % 9) + 1}-01` })) as never[];

describe("computeThesisBreakImpact", () => {
  it("reports shallower drawdown and smaller average loss as protective", () => {
    const r = computeThesisBreakImpact(
      arm({ maxDrawdownPct: -12, avgLossPct: -10.3, totalReturnPct: 2 }),
      arm({
        maxDrawdownPct: -6,
        avgLossPct: -6.8,
        totalReturnPct: 1.9,
        actionMix: { trim: 3, close: 2 },
        thesisEvents: evented(5),
      }),
    );
    expect(r.drawdownDeltaPp).toBe(6);
    expect(r.avgLossDeltaPp).toBe(3.5);
    expect(r.actions.total).toBe(5);
    expect(r.verdict).toBe("protective");
  });

  it("flags protection paid for with return", () => {
    const r = computeThesisBreakImpact(
      arm({ maxDrawdownPct: -12, avgLossPct: -10, totalReturnPct: 8 }),
      arm({
        maxDrawdownPct: -5,
        avgLossPct: -6,
        totalReturnPct: 1,
        actionMix: { trim: 1, close: 1 },
        thesisEvents: evented(2),
      }),
    );
    expect(r.returnDeltaPp).toBe(-7);
    expect(r.verdict).toBe("protective_but_costly");
  });

  it("reports no effect when the layer never fired", () => {
    const base = arm({ maxDrawdownPct: -9, avgLossPct: -5, totalReturnPct: 3 });
    const r = computeThesisBreakImpact(base, base);
    expect(r.verdict).toBe("no_effect");
    expect(r.drawdownDeltaPp).toBe(0);
  });

  it("calls it harmful when losses deepen", () => {
    const r = computeThesisBreakImpact(
      arm({ maxDrawdownPct: -8, avgLossPct: -5, totalReturnPct: 3 }),
      arm({
        maxDrawdownPct: -14,
        avgLossPct: -9,
        totalReturnPct: 1,
        actionMix: { trim: 0, close: 4 },
        thesisEvents: evented(4),
      }),
    );
    expect(r.verdict).toBe("harmful");
  });
});
