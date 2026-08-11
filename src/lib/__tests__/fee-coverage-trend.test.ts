import { describe, expect, it } from "vitest";
import { buildCoverageTrend, type CoverageFill } from "@/lib/fee-coverage-trend";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString();

function fill(portfolioId: string, offset: number, status: string): CoverageFill {
  return { portfolioId, filledAt: day(offset), feeSyncStatus: status };
}

const portfolios = [
  { id: "p1", name: "Balanced" },
  { id: "p2", name: "High risk" },
];

describe("buildCoverageTrend", () => {
  it("emits one point per day ending today", () => {
    const t = buildCoverageTrend({ fills: [], portfolios, days: 10, now: NOW });
    expect(t.dates).toHaveLength(10);
    expect(t.dates[9]).toBe("2026-08-11");
    expect(t.overall.points).toHaveLength(10);
  });

  it("scores coverage as invoiced over gradeable fills in the window", () => {
    const fills = [
      fill("p1", -1, "invoiced"),
      fill("p1", -2, "invoiced"),
      fill("p1", -3, "unmatched"),
      fill("p1", -4, "pending"),
    ];
    const t = buildCoverageTrend({ fills, portfolios, days: 10, windowDays: 14, now: NOW });
    expect(t.overall.latestPct).toBe(50);
    expect(t.overall.points.at(-1)).toMatchObject({ invoiced: 2, total: 4 });
  });

  it("excludes unsupported fills from the denominator", () => {
    const fills = [fill("p1", -1, "invoiced"), fill("p1", -2, "unsupported")];
    const t = buildCoverageTrend({ fills, portfolios, days: 5, now: NOW });
    expect(t.overall.latestPct).toBe(100);
    expect(t.overall.points.at(-1)?.total).toBe(1);
  });

  it("returns null coverage on days with no gradeable fills", () => {
    const t = buildCoverageTrend({
      fills: [fill("p1", -1, "invoiced")],
      portfolios,
      days: 3,
      windowDays: 1,
      now: NOW,
    });
    expect(t.overall.points[0]?.coveragePct).toBeNull();
    expect(t.overall.points.at(-1)?.coveragePct).toBe(100);
  });

  it("flags a degrading series when coverage falls", () => {
    const fills = [
      fill("p1", -40, "invoiced"),
      fill("p1", -39, "invoiced"),
      fill("p1", -2, "unmatched"),
      fill("p1", -1, "unmatched"),
    ];
    const t = buildCoverageTrend({ fills, portfolios, days: 45, windowDays: 5, now: NOW });
    expect(t.overall.direction).toBe("degrading");
    expect(t.overall.changePct).toBeLessThan(0);
  });

  it("flags an improving series when coverage recovers", () => {
    const fills = [
      fill("p1", -40, "unmatched"),
      fill("p1", -39, "unmatched"),
      fill("p1", -2, "invoiced"),
      fill("p1", -1, "invoiced"),
    ];
    const t = buildCoverageTrend({ fills, portfolios, days: 45, windowDays: 5, now: NOW });
    expect(t.overall.direction).toBe("improving");
    expect(t.overall.changePct).toBe(100);
  });

  it("splits per portfolio and drops portfolios with no fills", () => {
    const fills = [fill("p1", -1, "invoiced"), fill("p1", -2, "unmatched")];
    const t = buildCoverageTrend({ fills, portfolios, days: 10, now: NOW });
    expect(t.portfolios.map((p) => p.portfolioId)).toEqual(["p1"]);
    expect(t.portfolios[0]?.label).toBe("Balanced");
    expect(t.portfolios[0]?.latestPct).toBe(50);
  });

  it("blends portfolios in the overall line", () => {
    const fills = [
      fill("p1", -1, "invoiced"),
      fill("p2", -1, "unmatched"),
      fill("p2", -2, "unmatched"),
    ];
    const t = buildCoverageTrend({ fills, portfolios, days: 10, now: NOW });
    expect(t.overall.latestPct).toBeCloseTo(33.3, 1);
    expect(t.portfolios.find((p) => p.portfolioId === "p2")?.latestPct).toBe(0);
  });

  it("ignores fills older than the trailing window", () => {
    const t = buildCoverageTrend({
      fills: [fill("p1", -30, "invoiced"), fill("p1", -1, "unmatched")],
      portfolios,
      days: 10,
      windowDays: 7,
      now: NOW,
    });
    expect(t.overall.points.at(-1)).toMatchObject({ total: 1, invoiced: 0 });
  });

  it("is unknown when there is nothing to grade", () => {
    const t = buildCoverageTrend({ fills: [], portfolios, days: 10, now: NOW });
    expect(t.overall.direction).toBe("unknown");
    expect(t.overall.latestPct).toBeNull();
  });
});
