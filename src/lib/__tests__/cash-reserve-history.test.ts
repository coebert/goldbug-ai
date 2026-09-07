import { describe, expect, it } from "vitest";
import { buildCashReserveHistory } from "../cash-reserve-history";

describe("buildCashReserveHistory", () => {
  it("sizes reserves from each day's NAV and expires old costs", () => {
    const rows = buildCashReserveHistory(
      [
        { date: "2026-01-01", cash: 800, nav: 10_000 },
        { date: "2026-01-31", cash: 700, nav: 20_000 },
        { date: "2026-02-01", cash: 650, nav: 20_000 },
      ],
      [
        { date: "2026-01-01", costBase: 10 },
        { date: "2026-01-31", costBase: 7 },
      ],
    );
    expect(rows[0]).toMatchObject({ minimumBuy: 300, dealingAllowance: 40, trailingCost: 10, allowanceRemaining: 30 });
    expect(rows[1]).toMatchObject({ minimumBuy: 600, dealingAllowance: 80, trailingCost: 7, allowanceRemaining: 73 });
    expect(rows[2]).toMatchObject({ trailingCost: 7, allowanceRemaining: 73 });
  });

  it("omits snapshots without authoritative cash and clamps exhausted allowance", () => {
    const rows = buildCashReserveHistory(
      [
        { date: "2026-01-01", cash: null, nav: 10_000 },
        { date: "2026-01-02", cash: 400, nav: 10_000 },
      ],
      [{ date: "2026-01-02", costBase: 50 }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-01-02", cash: 400, allowanceRemaining: 0 });
  });
});
