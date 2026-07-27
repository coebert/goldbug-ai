import { describe, it, expect } from "vitest";
import { computeModeSummary } from "@/lib/mode-summary";
import { computeCardRangePct } from "@/lib/card-range-pct";
import { computeEquityChangeBreakdown } from "@/lib/equity-change-breakdown";
import { trailingAdjustedPct } from "@/lib/deposit-adjusted-series";

// Regression: the UI's % change (portfolio card sparkline via
// computeCardRangePct, and the new Equity-change breakdown card via
// computeEquityChangeBreakdown) MUST agree with the server-side
// dashboard aggregate (computeModeSummary) for the same window +
// deposit list, and MUST always exclude external cash-flows unless
// the user explicitly opts in via `includeDeposits`.
//
// One synthetic portfolio; we feed the exact same equity points +
// deposit events into every calculator and cross-check pct.

type Row = { snapshot_date: string; total_value: number };
const rows = (r: Array<[string, number]>): Row[] =>
  r.map(([snapshot_date, total_value]) => ({ snapshot_date, total_value }));

const toSeries = (r: Row[], pid: string) =>
  r.map((x) => ({ date: x.snapshot_date, [pid]: x.total_value }));

const toSpark = (r: Row[]) =>
  r.map((x) => ({ date: x.snapshot_date, value: x.total_value }));

const toEq = (r: Row[]) =>
  r.map((x) => ({ date: x.snapshot_date, equity: x.total_value }));

// Round to hundredths to compare independent floating computations.
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

const modeSummaryPctFor = (
  r: Row[],
  deposits: Array<{ portfolio_id: string; date: string; amount: number }>,
  pid = "p1",
  includeDeposits = false,
) => {
  // computeModeSummary anchors to the LAST two rows of the series
  // provided, so callers must pre-slice the window they want to
  // summarise. That's the same shape the tile uses on the home page.
  const twoPoint = r.length >= 2 ? [r[0], r[r.length - 1]] : r;
  const summary = computeModeSummary(
    toSeries(twoPoint, pid),
    [{ id: pid, mode: "live_sim" }],
    deposits,
    { includeDeposits },
  );
  return summary?.sim.pct ?? null;
};

describe("regression: UI % change equals server % change and excludes deposits", () => {
  it("pure trading — UI card, breakdown card and mode summary all report the same %", () => {
    const r = rows([
      ["2026-07-01", 1000],
      ["2026-07-15", 1050],
      ["2026-07-30", 1100],
    ]);

    const ui = computeCardRangePct(toSpark(r), [], false);
    const trailing = trailingAdjustedPct(toEq(r), []);
    const bd = computeEquityChangeBreakdown(r, [])!.totalPct;
    const server = modeSummaryPctFor(r, []);

    near(ui!, 10);
    near(trailing, 10);
    near(bd, 10);
    near(server!, 10);
  });

  it("mid-window deposit contributes 0% — UI, breakdown and server agree", () => {
    // 1000 → 1220 with a £200 deposit mid-window and £20 trading gain.
    const r = rows([
      ["2026-07-01", 1000],
      ["2026-07-10", 1210],
      ["2026-07-30", 1220],
    ]);
    const uiDep = [{ date: "2026-07-05", amount: 200 }];
    const svrDep = uiDep.map((d) => ({ ...d, portfolio_id: "p1" }));

    const ui = computeCardRangePct(toSpark(r), uiDep, false)!;
    const bd = computeEquityChangeBreakdown(r, uiDep)!.totalPct;
    const server = modeSummaryPctFor(r, svrDep)!;

    // Trading-only gain: (1220 − 200) − 1000 = 20 → 2%
    near(ui, 2);
    near(bd, 2);
    near(server, 2);
    near(ui, server);
    near(bd, server);
  });

  it("mid-window withdrawal contributes 0% — parity holds", () => {
    // 1000 → 900 with a £150 withdrawal, so trading contributed +£50.
    const r = rows([
      ["2026-07-01", 1000],
      ["2026-07-30", 900],
    ]);
    const uiDep = [{ date: "2026-07-15", amount: -150 }];
    const svrDep = uiDep.map((d) => ({ ...d, portfolio_id: "p1" }));

    const ui = computeCardRangePct(toSpark(r), uiDep, false)!;
    const bd = computeEquityChangeBreakdown(r, uiDep)!.totalPct;
    const server = modeSummaryPctFor(r, svrDep)!;

    // (900 − (−150)) − 1000 = 50 → 5%
    near(ui, 5);
    near(bd, 5);
    near(server, 5);
  });

  it("multiple deposits + withdrawals + fees — every calculator returns the same trading-only %", () => {
    const r = rows([
      ["2026-07-01", 1000],
      ["2026-07-08", 1200],
      ["2026-07-16", 1150],
      ["2026-07-24", 1160],
      ["2026-07-30", 1180],
    ]);
    const uiDep = [
      { date: "2026-07-03", amount: 200 }, // deposit
      { date: "2026-07-10", amount: -50 }, // withdrawal
      { date: "2026-07-12", amount: 15 }, // dividend (small)
      { date: "2026-07-20", amount: -5 }, // fee (small)
    ];
    const svrDep = uiDep.map((d) => ({ ...d, portfolio_id: "p1" }));

    const ui = computeCardRangePct(toSpark(r), uiDep, false)!;
    const bd = computeEquityChangeBreakdown(r, uiDep)!.totalPct;
    const server = modeSummaryPctFor(r, svrDep)!;

    // Δequity 180; external net = 200 − 50 + 15 − 5 = 160; trading = 20 → 2%
    near(ui, 2);
    near(bd, 2);
    near(server, 2);
  });

  it("includeDeposits=true reverses the netting on BOTH UI and server the same way", () => {
    const r = rows([
      ["2026-07-01", 1000],
      ["2026-07-30", 1220],
    ]);
    const uiDep = [{ date: "2026-07-05", amount: 200 }];
    const svrDep = uiDep.map((d) => ({ ...d, portfolio_id: "p1" }));

    const uiRaw = computeCardRangePct(toSpark(r), uiDep, true)!;
    const serverRaw = modeSummaryPctFor(r, svrDep, "p1", true)!;

    // Raw equity change: 220 / 1000 = 22%
    near(uiRaw, 22);
    near(serverRaw, 22);

    // And with the default (netted) mode they both drop back to the
    // trading-only figure — proving the toggle is symmetric across
    // the client / server boundary.
    const uiNet = computeCardRangePct(toSpark(r), uiDep, false)!;
    const serverNet = modeSummaryPctFor(r, svrDep)!;
    near(uiNet, 2);
    near(serverNet, 2);
  });

  it("deposits dated on or before the window baseline are ignored by BOTH sides", () => {
    const r = rows([
      ["2026-07-10", 1000],
      ["2026-07-30", 1100],
    ]);
    // Both events sit on or before the baseline (2026-07-10) → the
    // baseline already includes them, and neither computeModeSummary
    // nor computeCardRangePct should subtract them again.
    const uiDep = [
      { date: "2026-07-01", amount: 500 },
      { date: "2026-07-10", amount: 200 },
    ];
    const svrDep = uiDep.map((d) => ({ ...d, portfolio_id: "p1" }));

    const ui = computeCardRangePct(toSpark(r), uiDep, false)!;
    const server = modeSummaryPctFor(r, svrDep)!;
    const bd = computeEquityChangeBreakdown(r, uiDep)!.totalPct;

    // Δ 100 / 1000 = 10% — untouched by pre-window flows.
    near(ui, 10);
    near(server, 10);
    near(bd, 10);
  });

  it("fuzz: 50 randomised windows — UI card % and server % never diverge by more than 1e-6", () => {
    const rand = (() => {
      let s = 0xc0ffee;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    })();

    for (let i = 0; i < 50; i += 1) {
      const start = 500 + rand() * 5000;
      const tradingReturn = (rand() - 0.5) * 0.4; // −20% .. +20%
      const nExtras = Math.floor(rand() * 4); // 0..3 mid-window flows
      let externalNet = 0;
      const deposits: Array<{ portfolio_id: string; date: string; amount: number }> = [];
      const uiDeposits: Array<{ date: string; amount: number }> = [];
      for (let k = 0; k < nExtras; k += 1) {
        const amt = Math.round((rand() - 0.4) * 400); // biased positive
        if (amt === 0) continue;
        externalNet += amt;
        const day = 5 + Math.floor(rand() * 20); // between start and end
        const date = `2026-07-${String(day).padStart(2, "0")}`;
        deposits.push({ portfolio_id: "p1", date, amount: amt });
        uiDeposits.push({ date, amount: amt });
      }

      const end = start * (1 + tradingReturn) + externalNet;
      const r = rows([
        ["2026-07-01", start],
        ["2026-07-30", end],
      ]);

      const ui = computeCardRangePct(toSpark(r), uiDeposits, false)!;
      const server = modeSummaryPctFor(r, deposits)!;
      const bd = computeEquityChangeBreakdown(r, uiDeposits)!.totalPct;

      // All three must equal the pure trading return.
      const expectedPct = tradingReturn * 100;
      expect(Math.abs(ui - expectedPct)).toBeLessThan(1e-6);
      expect(Math.abs(server - expectedPct)).toBeLessThan(1e-6);
      expect(Math.abs(bd - expectedPct)).toBeLessThan(1e-6);
      expect(Math.abs(ui - server)).toBeLessThan(1e-6);
      expect(Math.abs(bd - server)).toBeLessThan(1e-6);
    }
  });
});
