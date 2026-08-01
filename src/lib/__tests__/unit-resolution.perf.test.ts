// Performance guardrail for symbol/unit resolution and parity maths.
//
// Every valuation pass runs these helpers once per holding, per price probe,
// and once more per rendered row — and the LSE variant work has grown
// (broker-native `MKS:xlon`, Yahoo `MKS.L`, GBX/GBP allowlists, observed-quote
// precedence). This test feeds realistic batch sizes through the same
// functions the kernel and the read paths use, and asserts:
//
//   1. absolute budgets: a full portfolio revaluation stays far inside a frame
//   2. parity: LSE variant-heavy symbols cost no more than a small multiple of
//      plain US symbols, so extra spellings never become the hot path
//   3. shape: cost grows linearly with batch size, not quadratically
//
// Budgets are deliberately generous versus observed local runs so CI noise
// cannot flake the test; they still catch an order-of-magnitude regression
// such as a per-call regex rebuild, an O(n²) variant scan, or an allowlist
// lookup that starts allocating.

import { describe, expect, it } from "vitest";
import {
  engineSymbolKey,
  priceSymbolVariants,
  resolvePriceSymbol,
} from "../price-symbol";
import {
  holdingAvgCostBase,
  isLsePenceQuoted,
  normalizeLseDisplayPriceToBase,
} from "../market-price-units";
import { computeValuation, resolveQuoteUnits } from "../valuation/kernel";
import { buildHoldingSeries, type PricePoint } from "../build-holding-series";

// Realistic upper bounds: a large multi-venue portfolio, revalued on every
// price refresh, plus a year of daily closes per holding for the charts.
const HOLDINGS = 500;
const PROBES_PER_HOLDING = 4;
const DAYS = 365;

const WARMUP = 2;
const RUNS = 5;

// Absolute budgets (ms) for the median run.
const SYMBOL_BATCH_BUDGET_MS = 25; // 500 × 4 probes → variants + engine keys
const UNIT_BATCH_BUDGET_MS = 20; // 500 × 4 price/cost normalisations
const VALUATION_BUDGET_MS = 40; // whole-portfolio kernel pass
const SERIES_BUDGET_MS = 120; // 500 holdings × 365 closes
// LSE symbols carry the extra variant work; they may cost more than plain US
// tickers, but not disproportionately so.
const LSE_VS_US_MAX_RATIO = 4;

const LSE_SPELLINGS = [
  (i: number) => `LSE${i}:xlon`,
  (i: number) => `LSE${i}.L`,
  (i: number) => `lse${i}:XLON`,
  (i: number) => ` LSE${i}.l `,
];
const US_SPELLINGS = [
  (i: number) => `US${i}`,
  (i: number) => `US${i}:xnas`,
  (i: number) => `US${i}:xnys`,
  (i: number) => `us${i}`,
];

function batchOf(spellings: Array<(i: number) => string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < HOLDINGS; i += 1) {
    for (let p = 0; p < PROBES_PER_HOLDING; p += 1) out.push(spellings[p](i));
  }
  return out;
}

const LSE_BATCH = batchOf(LSE_SPELLINGS);
const US_BATCH = batchOf(US_SPELLINGS);

/** Median wall time of `RUNS` measured iterations, after warmup. */
function median(fn: () => void): number {
  for (let i = 0; i < WARMUP; i += 1) fn();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

function resolveBatch(symbols: string[]): number {
  let acc = 0;
  for (const s of symbols) {
    acc += priceSymbolVariants(s).length;
    acc += engineSymbolKey(s).length;
    acc += resolvePriceSymbol(s).length;
  }
  return acc;
}

function unitBatch(symbols: string[]): number {
  let acc = 0;
  for (const s of symbols) {
    acc += isLsePenceQuoted(s) ? 1 : 0;
    acc += normalizeLseDisplayPriceToBase(s, 421.5, null);
    acc += holdingAvgCostBase(s, 4.21);
    acc += resolveQuoteUnits(s, null, null, "GBP").unitDivisor;
  }
  return acc;
}

/** Mixed-venue portfolio, the shape the kernel actually sees. */
const KERNEL_HOLDINGS = Array.from({ length: HOLDINGS }, (_, i) => {
  const venue = i % 3;
  if (venue === 0) return { symbol: `LSE${i}:xlon`, quantity: 100 + i, instrument_ccy: "GBX", avg_cost: 400 };
  if (venue === 1) return { symbol: `US${i}:xnas`, quantity: 10 + i, instrument_ccy: "USD", avg_cost: 200 };
  return { symbol: `EU${i}:xetr`, quantity: 25 + i, instrument_ccy: "EUR", avg_cost: 80 };
});

const PRICE_MAP = new Map<string, number>();
for (const h of KERNEL_HOLDINGS) {
  for (const key of priceSymbolVariants(h.symbol)) PRICE_MAP.set(key, 415.25);
}
const price = (s: string) => PRICE_MAP.get(String(s).toUpperCase()) ?? null;
const fx = (from: string, to: string) =>
  from === to ? 1 : from === "USD" ? 0.8 : from === "EUR" ? 0.85 : null;

const CLOSES: PricePoint[] = Array.from({ length: DAYS }, (_, d) => ({
  date: new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10),
  close: 400 + (d % 40),
}));

describe("perf: unit resolution and parity calculations", () => {
  it("resolves a full batch of symbol variants inside budget", () => {
    const ms = median(() => resolveBatch(LSE_BATCH));
    expect(resolveBatch(LSE_BATCH)).toBeGreaterThan(0);
    expect(ms).toBeLessThan(SYMBOL_BATCH_BUDGET_MS);
  });

  it("normalises a full batch of prices and cost bases inside budget", () => {
    const ms = median(() => unitBatch(LSE_BATCH));
    expect(ms).toBeLessThan(UNIT_BATCH_BUDGET_MS);
  });

  it("extra LSE spellings cost no more than a small multiple of plain US symbols", () => {
    const lse = median(() => {
      resolveBatch(LSE_BATCH);
      unitBatch(LSE_BATCH);
    });
    const us = median(() => {
      resolveBatch(US_BATCH);
      unitBatch(US_BATCH);
    });
    // Floor avoids dividing by a sub-millisecond timer reading.
    const ratio = lse / Math.max(us, 0.2);
    expect(ratio).toBeLessThan(LSE_VS_US_MAX_RATIO);
  });

  it("values a 500-holding mixed-venue portfolio inside budget", () => {
    let result: ReturnType<typeof computeValuation> | null = null;
    const ms = median(() => {
      result = computeValuation({
        holdings: KERNEL_HOLDINGS,
        wallet: { GBP: 1300.27, USD: 500 },
        baseCcy: "GBP",
        price,
        fx,
        asOf: "2026-08-01T16:35:00.000Z",
      });
    });
    expect(result!.provenance.lines).toHaveLength(HOLDINGS);
    expect(result!.provenance.degraded).toBe(false);
    expect(ms).toBeLessThan(VALUATION_BUDGET_MS);
  });

  it("builds a year of series for every holding inside budget", () => {
    const ms = median(() => {
      for (const h of KERNEL_HOLDINGS) {
        buildHoldingSeries(
          { symbol: h.symbol, quantity: h.quantity, avg_cost: 4, opened_at: "2025-01-01" },
          CLOSES,
        );
      }
    });
    expect(ms).toBeLessThan(SERIES_BUDGET_MS);
  });

  it("scales linearly with batch size, not quadratically", () => {
    const small = LSE_BATCH.slice(0, 250);
    const large = LSE_BATCH.slice(0, 1000); // 4x the work
    const tSmall = median(() => {
      resolveBatch(small);
      unitBatch(small);
    });
    const tLarge = median(() => {
      resolveBatch(large);
      unitBatch(large);
    });
    // Linear would be ~4x; quadratic would be ~16x. Allow generous slack for
    // timer granularity and JIT warmup while still failing on O(n²).
    const growth = tLarge / Math.max(tSmall, 0.05);
    expect(growth).toBeLessThan(10);
  });
});
