import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("src/routes/live-dashboard.tsx", "utf8");
const holdings = readFileSync("src/components/live-holdings-card.tsx", "utf8");
const fills = readFileSync("src/components/order-fills-card.tsx", "utf8");
const trading = readFileSync("src/components/live-trading-card.tsx", "utf8");

describe("live dashboard portrait mobile layout", () => {
  it("clips page overflow and lets both dashboard columns shrink", () => {
    expect(route).toContain('className="overflow-x-hidden"');
    expect(route).toMatch(/grid min-w-0 gap-4/);
    expect(route.match(/min-w-0 space-y-4/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("stacks metrics on the narrowest phones", () => {
    expect(route).toContain("grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:grid-cols-4");
    expect(holdings).toContain("grid grid-cols-1 gap-2 min-[360px]:grid-cols-2");
  });

  it("stacks dense headings and holding values before widening", () => {
    expect(holdings).toContain("grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]");
    expect(holdings).toContain("min-[390px]:grid-cols-[minmax(0,1fr)_auto]");
    expect(trading).toContain("grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]");
  });

  it("contains wide data tables inside local scrollers", () => {
    expect(route).toContain('className="max-w-full overflow-x-auto"');
    expect(holdings).toContain('className="max-w-full overflow-x-auto"');
    expect(fills).toContain("max-h-80 max-w-full overflow-auto");
  });
});