import { describe, expect, it } from "vitest";
import {
  activeAssetClasses,
  formatCandidateTable,
} from "@/lib/trading-engine/features-prompt";

const base = {
  symbol: "VOD.L",
  name: "Vodafone (LON)",
  asset_class: "stock",
  price: 118.650002,
  sma20: 115.03450009999999,
  sma50: null,
  rsi14: 60.87689859490479,
  change5d: -0.037322498985801214,
  change30d: 0.11513157678324104,
  vol20d: 0.03547642938228721,
  macd_hist: 0.3378050147142013,
  macd_bull_cross: false,
  macd_bear_cross: true,
  bb_width: 0.2237497901336202,
  atr_pct: 7.211095536746328,
  adv_20d: 124072229.25,
  vw_momentum_10d: 0.008789453927903954,
  weekly_trend_up: false,
  weekly_rsi14: null,
  news_score: -0.004,
  news_contributors: 0,
  news_momentum: null,
  event_features: null,
  cooling: false,
  rank_info: null,
};

describe("formatCandidateTable", () => {
  it("emits one row per candidate plus a legend", () => {
    const out = formatCandidateTable([base, { ...base, symbol: "BP.L" }]);
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("VOD.L |"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("BP.L |"))).toHaveLength(1);
    expect(out).toContain("Columns: symbol | name | class");
  });

  it("keeps nulls distinguishable from zero", () => {
    const row = formatCandidateTable([base]).split("\n").at(-1)!;
    const cells = row.split(" || ")[0].split(" | ");
    expect(cells[5]).toBe("-"); // sma50 is null, not 0
    expect(cells[17]).toBe("-"); // weekly_rsi14 is null, not 0
  });

  it("encodes MACD crosses as a single flag", () => {
    const bear = formatCandidateTable([base]).split("\n").at(-1)!;
    expect(bear.split(" || ")[0].split(" | ")[11]).toBe("R");
    const bull = formatCandidateTable([
      { ...base, macd_bear_cross: false, macd_bull_cross: true },
    ])
      .split("\n")
      .at(-1)!;
    expect(bull.split(" || ")[0].split(" | ")[11]).toBe("B");
  });

  it("renders sentiment, event and rank sub-blocks when present", () => {
    const row = formatCandidateTable([
      {
        ...base,
        news_score: 0.42,
        news_contributors: 3,
        news_momentum: {
          today: 0.5,
          avg_3d: 0.4,
          avg_7d: 0.2,
          delta_3d: 0.3,
          delta_7d: 0.2,
          accel: 0.1,
          contributors_7d: 9,
        },
        event_features: {
          event_score: -0.25,
          event_pressure: 0.8,
          event_count: 4,
          hard_catalyst: true,
          top_kinds: ["earnings", "guidance"],
        },
        rank_info: {
          composite_score: 1.23,
          percentile: 0.95,
          rank: 2,
          universe_size: 22,
          top_decile: true,
          top_quartile: true,
          momentum_z: 1.1,
          quality_z: 0.4,
          low_vol_z: -0.2,
          trend_z: 0.9,
        },
      },
    ])
      .split("\n")
      .at(-1)!;
    expect(row).toContain("news 0.42/3 t0.5");
    expect(row).toContain("events s:-0.25 p:0.8 nx4 hard:Y earnings/guidance");
    expect(row).toContain("rank #2/22 p0.95");
    expect(row).toContain("TOP10%");
  });

  it("is far smaller than pretty-printed JSON for a full universe", () => {
    const feats = Array.from({ length: 22 }, (_, i) => ({
      ...base,
      symbol: `SYM${i}.L`,
    }));
    const pretty = JSON.stringify(feats, null, 2).length;
    expect(formatCandidateTable(feats).length).toBeLessThan(pretty * 0.45);
  });

  it("handles an empty candidate list", () => {
    expect(formatCandidateTable([])).toContain("none passed");
  });
});

describe("activeAssetClasses", () => {
  it("unions candidate and holding classes, lower-cased", () => {
    const s = activeAssetClasses(
      [base, { ...base, asset_class: "ETF" }],
      [{ symbol: "BTC-USD", asset_class: "crypto" }],
    );
    expect([...s].sort()).toEqual(["crypto", "etf", "stock"]);
  });

  it("ignores missing classes", () => {
    expect(activeAssetClasses([{ symbol: "X" }], [{ symbol: "Y" }]).size).toBe(0);
  });
});
