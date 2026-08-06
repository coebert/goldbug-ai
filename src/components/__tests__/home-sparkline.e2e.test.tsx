// End-to-end style test for the home dashboard sparkline.
//
// Wires the real `computeSparkByPortfolio` selector to the real <Sparkline>
// SVG component (exactly like `src/routes/index.tsx` does) and asserts that
// the rendered polyline plots ONLY the selected portfolio's own snapshot
// dates and values — never back-filled from another portfolio's series or
// from the merged multi-portfolio axis.
//
// Uses react-dom/server so no jsdom is required; we parse the produced SVG
// path directly.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Sparkline } from "../sparkline";
import { computeSparkByPortfolio, type SparkPoint } from "@/lib/spark-by-portfolio";

const WIDTH = 120;
const HEIGHT = 36;

import { sparklineDomain } from "@/lib/sparkline-scale";

function renderPortfolioSpark(series: SparkPoint[]) {
  return renderToStaticMarkup(
    <Sparkline values={series.map((p) => p.value)} width={WIDTH} height={HEIGHT} />,
  );
}

// Extracts numeric (x, y) pairs from the polyline path emitted by <Sparkline>.
function parsePoints(html: string): Array<{ x: number; y: number }> {
  const strokeMatch = html.match(/<path d="M([^"]+)" fill="none"/);
  if (!strokeMatch) return [];
  return strokeMatch[1]
    .split("L")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
}

describe("home sparkline (e2e)", () => {
  // Realistic dashboard state: a mature simulated portfolio with 5 daily
  // snapshots and a brand-new live portfolio with a single snapshot at a
  // different date. The merged `series` axis would otherwise back-fill the
  // live portfolio with starting_cash on the sim's dates and fabricate a
  // drop — that regression must not happen.
  const equityData = {
    portfolios: [
      { id: "sim-1", mode: "sim" as const },
      { id: "live-1", mode: "live" as const },
    ],
    perPortfolioSeries: {
      "sim-1": [
        { date: "2026-07-20", value: 1000 },
        { date: "2026-07-21", value: 1010 },
        { date: "2026-07-22", value: 990 },
        { date: "2026-07-23", value: 1025 },
        { date: "2026-07-24", value: 1040 },
      ],
      "live-1": [{ date: "2026-07-24", value: 300.46 }],
    },
    // Merged axis is intentionally polluted with the sim's dates back-filled
    // for `live-1` at starting_cash 330 — the bug scenario.
    series: [
      { date: "2026-07-20", "sim-1": 1000, "live-1": 330 },
      { date: "2026-07-21", "sim-1": 1010, "live-1": 330 },
      { date: "2026-07-22", "sim-1": 990, "live-1": 330 },
      { date: "2026-07-23", "sim-1": 1025, "live-1": 330 },
      { date: "2026-07-24", "sim-1": 1040, "live-1": 300.46 },
    ],
  };

  const sparkByPortfolio = computeSparkByPortfolio(equityData);

  it("plots exactly the sim portfolio's own snapshots (5 points)", () => {
    const own = sparkByPortfolio["sim-1"];
    expect(own).toHaveLength(5);
    const html = renderPortfolioSpark(own);
    const pts = parsePoints(html);
    expect(pts).toHaveLength(5);

    // X-axis is evenly spaced across the width for exactly N points.
    const stepX = WIDTH / (own.length - 1);
    pts.forEach((p, i) => {
      expect(p.x).toBeCloseTo(i * stepX, 1);
    });

    // Trend endpoints map to the portfolio's own first/last values under the
    // shared padded domain (sparklineDomain), which every chart of this type
    // now uses. This proves y comes from sim-1's own values, not a merged axis.
    const { min: dMin, max: dMax } = sparklineDomain(own.map((p) => p.value));
    const yOf = (v: number) => HEIGHT - ((v - dMin) / (dMax - dMin)) * HEIGHT;
    const first = pts[0];
    const last = pts[pts.length - 1];
    expect(first.y).toBeCloseTo(yOf(1000), 1);
    expect(last.y).toBeCloseTo(yOf(1040), 1);
    // Padding means the extremes sit inside the box rather than on its edges.
    expect(last.y).toBeGreaterThan(0);

    // Positive net change → upward stroke color.
    expect(html).toContain('aria-label="Trend up"');
    expect(html).toContain("#4ade80");
    expect(html).not.toContain("#f87171");
  });

  it("renders the single-snapshot live portfolio as empty — never back-filled from the sim's dates", () => {
    const own = sparkByPortfolio["live-1"];
    expect(own).toHaveLength(1);
    expect(own[0]).toEqual({ date: "2026-07-24", value: 300.46 });

    const html = renderPortfolioSpark(own);
    // No polyline is drawn for <2 points — proves the merged axis was NOT
    // consulted (which would have produced 5 fake points and a fake drop).
    expect(html).not.toContain("<path");
    expect(html).toContain('aria-label="Not enough data for trend"');
    // And crucially, the phantom starting_cash value 330 must not appear
    // anywhere in the rendered live sparkline.
    expect(html).not.toMatch(/330(\.|,|<|")/);
  });

  it("never mixes values between portfolios", () => {
    // Every plotted y-coordinate for sim-1 must correspond to one of sim-1's
    // own values under its own (min,max) — no live-1 values leak in.
    const own = sparkByPortfolio["sim-1"];
    const values = own.map((p) => p.value);
    const min = Math.min(...values);
    const { min: dMin, max: dMax } = sparklineDomain(values);

    const html = renderPortfolioSpark(own);
    const pts = parsePoints(html);
    const expectedYs = values.map((v) => HEIGHT - ((v - dMin) / (dMax - dMin)) * HEIGHT);
    pts.forEach((p, i) => expect(p.y).toBeCloseTo(expectedYs[i], 1));

    // If the live portfolio's value (300.46) had leaked into sim's range, the
    // domain would stretch far below 990 and sim's own min would be pushed to
    // the top of the box. It must stay in the lower part of its own axis.
    const minIdx = values.indexOf(min);
    expect(pts[minIdx].y).toBeGreaterThan(HEIGHT * 0.8);
    expect(pts[minIdx].y).toBeLessThanOrEqual(HEIGHT);
    // And no plotted x corresponds to the live portfolio's single point.
    expect(pts).toHaveLength(values.length);
  });

  it("handles a portfolio with no snapshots without crashing or fabricating points", () => {
    const empty = computeSparkByPortfolio({
      portfolios: [{ id: "new-1", mode: "sim" }],
      perPortfolioSeries: {},
      series: [
        { date: "2026-07-20", "sim-1": 1000 },
        { date: "2026-07-21", "sim-1": 1010 },
      ],
    });
    expect(empty["new-1"]).toEqual([]);
    const html = renderPortfolioSpark(empty["new-1"]);
    expect(html).not.toContain("<path");
    expect(html).toContain('aria-label="Not enough data for trend"');
  });
});
