import { describe, it, expect } from "vitest";
import { buildEquityComposition } from "@/lib/equity-composition";
describe("composition", () => {
  it("stacks to total", () => {
    const r = buildEquityComposition({
      snapshots: [
        { snapshot_date: "2026-01-02", cash: 500, holdings_value: 500, total_value: 1000 },
        { snapshot_date: "2026-01-03", cash: 400, holdings_value: 700, total_value: 1100 },
      ],
      trades: [{ trade_date: "2026-01-02", symbol: "A:xnas", side: "buy", quantity: 10 }],
      prices: { "A:xnas": [{ date: "2026-01-02", close: 50 }, { date: "2026-01-03", close: 70 }] },
    });
    expect(r.symbols).toEqual(["A:xnas"]);
    expect(r.rows[1]).toMatchObject({ cash: 400, "A:xnas": 700, total: 1100 });
  });
});
