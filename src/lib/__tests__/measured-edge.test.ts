import { describe, it, expect } from "vitest";
import { measuredEdgeFromSignals, EDGE_PRIOR, EDGE_MIN, EDGE_MAX } from "../measured-edge";

const row = (o: Partial<Parameters<typeof measuredEdgeFromSignals>[0][number]>) => ({
  signal_name: "sma_trend",
  samples: 0,
  hit_rate: null,
  avg_edge_bps: null,
  weight_avg: 100,
  ...o,
});

describe("measuredEdgeFromSignals", () => {
  it("falls back to the prior with no measurement", () => {
    const r = measuredEdgeFromSignals([row({}), row({ signal_name: "rsi" })]);
    expect(r.edge).toBe(EDGE_PRIOR);
    expect(r.usedPrior).toBe(true);
    expect(r.samples).toBe(0);
  });

  it("shrinks a small sample toward the prior", () => {
    const r = measuredEdgeFromSignals([
      row({ samples: 5, hit_rate: 0.8, avg_edge_bps: 500 }),
    ]);
    expect(r.rawEdge).toBeCloseTo(0.05, 6);
    expect(r.edge).toBeGreaterThan(EDGE_PRIOR);
    expect(r.edge).toBeLessThan(0.05);
  });

  it("trusts a large sample nearly in full", () => {
    const r = measuredEdgeFromSignals([
      row({ samples: 400, hit_rate: 0.6, avg_edge_bps: 300 }),
    ]);
    expect(r.edge).toBeGreaterThan(0.028);
    expect(r.edge).toBeLessThanOrEqual(0.03);
    expect(r.usedPrior).toBe(false);
  });

  it("lets a measured negative edge pull sizing down", () => {
    const r = measuredEdgeFromSignals([
      row({ samples: 300, hit_rate: 0.3, avg_edge_bps: -400 }),
    ]);
    expect(r.rawEdge).toBeLessThan(0);
    expect(r.edge).toBe(EDGE_MIN);
  });

  it("clamps an implausible measurement", () => {
    const r = measuredEdgeFromSignals([
      row({ samples: 500, hit_rate: 0.95, avg_edge_bps: 5000 }),
    ]);
    expect(r.edge).toBe(EDGE_MAX);
  });

  it("weights signals by how much they actually drove decisions", () => {
    const dominant = measuredEdgeFromSignals([
      row({ signal_name: "sma_trend", samples: 100, hit_rate: 0.6, avg_edge_bps: 400, weight_avg: 90 }),
      row({ signal_name: "rsi", samples: 100, hit_rate: 0.4, avg_edge_bps: -400, weight_avg: 10 }),
    ]);
    expect(dominant.rawEdge!).toBeGreaterThan(0.02);
    expect(dominant.hitRate!).toBeGreaterThan(0.5);
  });

  it("ignores rows with no samples or no edge", () => {
    const r = measuredEdgeFromSignals([
      row({ samples: 0, avg_edge_bps: 900 }),
      row({ signal_name: "rsi", samples: 50, avg_edge_bps: null }),
      row({ signal_name: "volatility", samples: 50, hit_rate: 0.55, avg_edge_bps: 200 }),
    ]);
    expect(r.samples).toBe(50);
    expect(r.rawEdge).toBeCloseTo(0.02, 6);
  });
});
