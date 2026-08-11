// @vitest-environment jsdom
//
// The heatmap's whole value is the interaction — hover a cell, read calm vs
// stress vs Δ, switch layer — so this suite drives a real DOM rather than
// asserting on SSR markup like the chart contract tests do.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";

import { SpilloverHeatmapViewer } from "../spillover-heatmap-card";
import type { SpilloverHeatmapResponse } from "@/lib/spillover-heatmap.functions";

const cell = (calm: number | null, stress: number | null, extra: Partial<{
  pairs: number; calmWindows: number; stressWindows: number;
}> = {}) => ({
  calm,
  stress,
  delta: calm !== null && stress !== null ? stress - calm : null,
  pairs: extra.pairs ?? 6,
  calmWindows: extra.calmWindows ?? 40,
  stressWindows: extra.stressWindows ?? 12,
});

const data: SpilloverHeatmapResponse = {
  clusters: ["us-index", "us-tech", "metals"],
  cells: [
    [cell(0.62, 0.81), cell(0.44, 0.72), cell(0.08, 0.05)],
    [cell(0.44, 0.72), cell(0.58, 0.79), cell(0.06, 0.09, { stressWindows: 3 })],
    [cell(0.08, 0.05), cell(0.06, 0.09, { stressWindows: 3 }), cell(0.31, null, { stressWindows: 0 })],
  ],
  members: [
    { cluster: "us-index", symbols: ["SPY", "IWM"] },
    { cluster: "us-tech", symbols: ["AAPL", "MSFT", "NVDA"] },
    { cluster: "metals", symbols: ["GLD"] },
  ],
  windows: 520,
  stressWindows: 31,
  window: 60,
  step: 5,
  basis: "absReturns",
  bars: 1400,
  from: "2021-01-04",
  to: "2026-08-01",
  usableSymbols: ["SPY", "IWM", "AAPL", "MSFT", "NVDA", "GLD"],
  skippedSymbols: ["TLT"],
};

const cells = () => Array.from(document.querySelectorAll("td button"));

describe("SpilloverHeatmapViewer", () => {
  it("renders a square grid with one button per cluster pair", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    expect(cells()).toHaveLength(9);
    expect(screen.getAllByText("us-tech").length).toBeGreaterThan(0);
  });

  it("shows calm, stress and delta in the hover tooltip", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    fireEvent.mouseEnter(cells()[1]!); // us-index ↔ us-tech
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText(/us-index/)).toBeTruthy();
    expect(within(tip).getByText("0.440")).toBeTruthy();
    expect(within(tip).getByText("0.720")).toBeTruthy();
    expect(within(tip).getByText("+0.280")).toBeTruthy();
    expect(tip.textContent).toContain("6 symbol pairs");
    expect(tip.textContent).toContain("40 calm / 12 stressed windows");
  });

  it("hides the tooltip when the pointer leaves", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    fireEvent.mouseEnter(cells()[1]!);
    expect(screen.queryByRole("tooltip")).toBeTruthy();
    fireEvent.mouseLeave(cells()[1]!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens the tooltip on keyboard focus too", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    fireEvent.focus(cells()[2]!);
    expect(screen.getByRole("tooltip").textContent).toContain("metals");
  });

  it("warns when a stress leg is fitted on very few windows", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    fireEvent.mouseEnter(cells()[5]!); // us-tech ↔ metals, 3 stressed windows
    expect(screen.getByRole("tooltip").textContent).toContain("thin stress fit");
  });

  it("switches the displayed layer and headline pair", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    // Δ layer is the default: us-index ↔ us-tech uplift is 0.280.
    expect(screen.getByText(/Strongest cross-cluster channel/).textContent)
      .toContain("0.280");
    expect(cells()[1]!.textContent).toBe("0.28");

    fireEvent.click(screen.getByRole("button", { name: "Stress ρ" }));
    expect(cells()[1]!.textContent).toBe("0.72");
    expect(screen.getByText(/Strongest cross-cluster channel/).textContent)
      .toContain("0.720");

    fireEvent.click(screen.getByRole("button", { name: "Calm ρ" }));
    expect(cells()[1]!.textContent).toBe("0.44");
  });

  it("labels unobserved values as n/a rather than zero", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Stress ρ" }));
    expect(cells()[8]!.textContent).toBe("n/a"); // metals diagonal, no stress windows
  });

  it("pins a cell on click and unpins it on a second click", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    fireEvent.click(cells()[1]!);
    expect(screen.getByText(/AAPL, MSFT, NVDA/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
    expect(screen.queryByText(/AAPL, MSFT, NVDA/)).toBeNull();
  });

  it("exposes the three values to screen readers on every cell", () => {
    render(<SpilloverHeatmapViewer data={data} />);
    expect(cells()[1]!.getAttribute("aria-label"))
      .toBe("us-index to us-tech: calm 0.440, stress 0.720, delta 0.280");
  });

  it("degrades to an explanation when there is no matrix", () => {
    render(
      <SpilloverHeatmapViewer
        data={{ ...data, clusters: [], cells: [], members: [], skippedSymbols: ["TLT"] }}
      />,
    );
    expect(screen.getByText(/Not enough overlapping price history/).textContent)
      .toContain("TLT");
  });
});
