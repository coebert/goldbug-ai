// Renders the concentration prompt to static markup (no jsdom needed) and
// asserts the breach, suggested trim and risk-impact block are present.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConcentrationAlertCard } from "../concentration-alert-card";

// Real-money book as of 12 Aug 2026: MKS is ~30% of a ~£9.96k portfolio.
const HOLDINGS = [
  { id: "h1", symbol: "MKS:xlon", quantity: 775, avg_cost: 4.0528, instrument_ccy: "GBP" },
  { id: "h2", symbol: "HSBA:xlon", quantity: 24, avg_cost: 15.562, instrument_ccy: "GBP" },
  { id: "h3", symbol: "VUSA:xlon", quantity: 21, avg_cost: 108.0449, instrument_ccy: "GBP" },
];

const SERIES = {
  "MKS:xlon": { currentPrice: 3.876 },
  "HSBA:xlon": { currentPrice: 15.314 },
  "VUSA:xlon": { currentPrice: 108.6512 },
};

function html(totalValue: number) {
  return renderToStaticMarkup(
    <ConcentrationAlertCard
      holdings={HOLDINGS}
      series={SERIES}
      totalValue={totalValue}
      currency="GBP"
      mode="live_prod"
    />,
  );
}

describe("ConcentrationAlertCard", () => {
  it("prompts a trim when a holding breaches the cap", () => {
    const out = html(9962.32);
    expect(out).toContain("MKS:xlon");
    expect(out).toContain("over your 15% single-holding cap");
    expect(out).toMatch(/Trim \d+%/);
    expect(out).toContain("Expected impact on risk");
    // HSBA (~3.7%) and VUSA (~22.9%)… VUSA also breaches, MKS is listed first.
    expect(out.indexOf("MKS:xlon")).toBeLessThan(out.indexOf("VUSA:xlon"));
    expect(out).not.toContain("HSBA:xlon");
  });

  it("renders nothing when every holding is inside the cap", () => {
    expect(html(100_000)).toBe("");
  });
});
