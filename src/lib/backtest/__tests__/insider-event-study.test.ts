import { describe, expect, it } from "vitest";
import {
  buildEventOutcomes,
  classifyEvents,
  classifyTransactionText,
  collapseSameDay,
  summariseStudy,
  studyVerdict,
  type Candlelike,
  type InsiderTx,
} from "../insider-event-study";

function tape(start: string, closes: number[]): Candlelike[] {
  const out: Candlelike[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (const close of closes) {
    out.push({ date: d.toISOString().slice(0, 10), close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("classifyTransactionText", () => {
  it("reads open-market sales as discretionary", () => {
    const c = classifyTransactionText("Sale at price 3.84 per share.");
    expect(c.action).toBe("sell");
    expect(c.flavour).toBe("discretionary");
  });

  it("treats awards and option exercises as mechanical", () => {
    expect(classifyTransactionText("Stock Award(Grant)").flavour).toBe("mechanical");
    expect(classifyTransactionText("Conversion of Exercise of derivative security").flavour).toBe(
      "mechanical",
    );
  });
});

describe("collapseSameDay", () => {
  const base: Omit<InsiderTx, "person" | "value" | "shares"> = {
    symbol: "MKS.L",
    date: "2026-07-08",
    role: "Officer",
    text: "Sale at price 3.84 per share.",
  };

  it("merges same symbol+day+direction filings and sums consideration", () => {
    const events = classifyEvents([
      { ...base, person: "A", shares: 100, value: 1_000 },
      { ...base, person: "B", shares: 200, value: 2_000 },
      { ...base, date: "2026-07-09", person: "C", shares: 50, value: 500 },
    ]);
    const merged = collapseSameDay(events);
    expect(merged).toHaveLength(2);
    const day = merged.find((e) => e.date === "2026-07-08");
    expect(day?.value).toBe(3_000);
    expect(day?.shares).toBe(300);
  });

  it("keeps buys and sells apart on the same day", () => {
    const events = classifyEvents([
      { ...base, person: "A", shares: 10, value: 100 },
      { ...base, person: "B", shares: 10, value: 100, text: "Purchase at price 3.80 per share." },
    ]);
    expect(collapseSameDay(events)).toHaveLength(2);
  });

  it("stops clustered filings from inflating the sample", () => {
    const prices = new Map<string, Candlelike[]>([["MKS.L", tape("2026-07-06", [100, 100, 99, 98, 97, 96])]]);
    const bench = new Map<string, Candlelike[]>([["^FTSE", tape("2026-07-06", [100, 100, 100, 100, 100, 100])]]);
    const events = classifyEvents([
      { ...base, person: "A", shares: 100, value: 1_000 },
      { ...base, person: "B", shares: 100, value: 1_000 },
      { ...base, person: "C", shares: 100, value: 1_000 },
    ]);
    const out = buildEventOutcomes(events, prices, bench, () => "^FTSE", {
      horizons: [1],
      minValue: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.value).toBe(3_000);

    const uncollapsed = buildEventOutcomes(events, prices, bench, () => "^FTSE", {
      horizons: [1],
      minValue: 0,
      collapse: false,
    });
    expect(uncollapsed).toHaveLength(3);
  });
});

describe("summariseStudy / studyVerdict", () => {
  it("flags tiny samples as insufficient evidence rather than a signal", () => {
    const prices = new Map<string, Candlelike[]>([
      ["AAA", tape("2026-01-01", [100, 101, 99, 102, 98, 103, 97, 104])],
    ]);
    const bench = new Map<string, Candlelike[]>([
      ["^GSPC", tape("2026-01-01", [100, 100, 100, 100, 100, 100, 100, 100])],
    ]);
    const events = classifyEvents(
      ["2026-01-01", "2026-01-02", "2026-01-03"].map((date) => ({
        symbol: "AAA",
        date,
        person: "X",
        role: "CEO",
        shares: 10,
        value: 100_000,
        text: "Sale at price 10 per share.",
      })),
    );
    const out = buildEventOutcomes(events, prices, bench, () => "^GSPC", {
      horizons: [1],
      minValue: 0,
    });
    const study = summariseStudy(out, [1]);
    const verdict = studyVerdict(study, 1);
    expect(verdict.verdict).toBe("insufficient_evidence");
    expect(verdict.supported_nudge).toBe(0);
  });
});
