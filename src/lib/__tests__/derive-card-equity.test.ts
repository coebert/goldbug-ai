import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  deriveCardEquity,
  EquitySourceMismatchError,
} from "../derive-card-equity";

const series = [
  { date: "2025-01-01", value: 10_000 },
  { date: "2025-01-02", value: 10_500 },
  { date: "2025-01-03", value: 11_000 },
];

describe("deriveCardEquity — runtime source-alignment checks", () => {
  it("returns totalEquity == last sparkSeries value and computes rangePct from the same series", () => {
    const out = deriveCardEquity(series, series, [], false, 999);
    expect(out.totalEquity).toBe(11_000);
    expect(out.sourceLastValue).toBe(11_000);
    expect(out.sourceLastDate).toBe("2025-01-03");
    expect(out.hasSeries).toBe(true);
    expect(out.rangePct).not.toBeNull();
  });

  it("falls back to fallbackCash only when sparkSeries is empty", () => {
    const out = deriveCardEquity([], [], [], false, 2_500);
    expect(out.totalEquity).toBe(2_500);
    expect(out.hasSeries).toBe(false);
    expect(out.sourceLastValue).toBeUndefined();
    expect(out.rangePct).toBeNull();
  });

  it("throws fast in dev when the sliced range series is a foreign array (last point differs)", () => {
    const foreign = [
      { date: "2025-01-03", value: 12_345 }, // same date, different value
    ];
    expect(() =>
      deriveCardEquity(series, foreign, [], false, 0),
    ).toThrow(EquitySourceMismatchError);
  });

  it("throws when the sliced series' last date does not match sparkSeries", () => {
    const foreign = [{ date: "2025-01-02", value: 10_500 }]; // wrong last date
    expect(() =>
      deriveCardEquity(series, foreign, [], false, 0),
    ).toThrow(/sliced range series does not share the last point/);
  });

  it("permits sliced to be a suffix of sparkSeries (identity on last point)", () => {
    const suffix = series.slice(-2);
    const out = deriveCardEquity(series, suffix, [], false, 0);
    expect(out.totalEquity).toBe(11_000);
    expect(out.rangePct).not.toBeNull();
  });

  it("throws when fallbackCash is not finite and series is empty", () => {
    expect(() =>
      deriveCardEquity([], [], [], false, Number.NaN),
    ).toThrow(EquitySourceMismatchError);
  });

  describe("production runtime (NODE_ENV=production)", () => {
    const prevEnv = process.env.NODE_ENV;
    let errSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      process.env.NODE_ENV = "production";
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      process.env.NODE_ENV = prevEnv;
      errSpy.mockRestore();
    });

    it("logs a structured error instead of throwing on divergence", () => {
      const foreign = [{ date: "2025-01-03", value: 42 }];
      expect(() =>
        deriveCardEquity(series, foreign, [], false, 0),
      ).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1);
      const [msg, details] = errSpy.mock.calls[0];
      expect(String(msg)).toMatch(/card-equity/);
      expect(details).toMatchObject({
        seriesLast: { date: "2025-01-03", value: 11_000 },
        slicedLast: { date: "2025-01-03", value: 42 },
      });
    });
  });
});
