import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("ConcentrationAlertCard", () => {
  it("prompts a trim when a holding breaches the cap", () => {
    render(
      <ConcentrationAlertCard
        holdings={HOLDINGS}
        series={SERIES}
        totalValue={9962.32}
        currency="GBP"
        mode="live_prod"
      />,
    );
    const alert = screen.getByTestId("concentration-alert");
    expect(alert.textContent).toContain("MKS:xlon");
    expect(alert.textContent).toContain("over your 15% single-holding cap");
    expect(screen.getByRole("button", { name: /Trim \d+%/ })).toBeTruthy();
    expect(alert.textContent).toContain("Expected impact on risk");
  });

  it("renders nothing when every holding is inside the cap", () => {
    const { container } = render(
      <ConcentrationAlertCard
        holdings={HOLDINGS}
        series={SERIES}
        totalValue={100_000}
        currency="GBP"
        mode="live_prod"
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
