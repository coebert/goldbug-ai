// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InsiderDealingDetailPanel } from "@/components/insider-dealing-detail-panel";
import type { InsiderDealingEvent } from "@/lib/insider-dealings";

const event: InsiderDealingEvent = {
  symbol: "MKS.L",
  company: "Marks & Spencer",
  event_date: "2026-07-22",
  headline: "RNS: S Berendji sold 300,000 shares at £3.976 in Marks & Spencer",
  summary: "PDMR (Operations Director). Sale of ordinary shares",
  source: "RNS (Investegate)",
  url: "https://investegate.co.uk/x",
  direction: "sell",
  flavour: "discretionary",
  person: "S Berendji",
  role: "Director",
  shares: 300000,
  value: 1192800,
  severity: 0.5,
  sentiment_nudge: -0.075,
};

describe("InsiderDealingDetailPanel", () => {
  it("shows filing fields, disposal type, matched ticker and the applied nudge", () => {
    render(<InsiderDealingDetailPanel event={event} symbolEvents={[event]} open onOpenChange={() => {}} />);
    expect(screen.getByText("S Berendji")).toBeTruthy();
    expect(screen.getByText("300,000 shares")).toBeTruthy();
    expect(screen.getByText(/Disposal — open market/)).toBeTruthy();
    expect(screen.getAllByText("MKS.L").length).toBeGreaterThan(0);
    expect(screen.getByText("Applied to news score")).toBeTruthy();
    expect(screen.getAllByText("-0.075").length).toBeGreaterThan(0);
  });

  it("renders nothing when no event is selected", () => {
    const { container } = render(<InsiderDealingDetailPanel event={null} open={false} onOpenChange={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
