// Unit tests for the crypto ETP ↔ saxo_instrument_cache sync validator.
//
// Locks the behavior the broker upsert hook relies on:
//   - happy path: every approved ETP has a fresh, correctly-typed row.
//   - missing: any approved ETP without a cache row is flagged.
//   - wrong asset_type: rows outside CRYPTO_ALLOWED_SAXO_ASSET_TYPES flag.
//   - stale: refreshed_at older than CRYPTO_CACHE_MAX_AGE_MS flags.
//   - unknown: cache rows for symbols not in CRYPTO_SYMBOL_MAP flag.
//   - env isolation: sim rows don't satisfy live checks and vice-versa.

import { describe, it, expect } from "vitest";
import {
  approvedCryptoEtps,
  isApprovedCryptoEtp,
  validateCryptoCacheSync,
  CRYPTO_CACHE_MAX_AGE_MS,
  type CryptoCacheRow,
} from "@/lib/crypto-cache-sync";
import { CRYPTO_SYMBOL_MAP } from "@/lib/crypto-groups";
import { CRYPTO_ALLOWED_SAXO_ASSET_TYPES } from "@/lib/crypto-validation.server";

const NOW = new Date("2026-02-03T10:00:00Z");
const FRESH = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(); // 1d old

function freshRow(symbol: string, env: string, assetType = "Etp"): CryptoCacheRow {
  return { symbol, env, asset_type: assetType, refreshed_at: FRESH };
}

function fullSnapshot(env: string, assetType = "Etp"): CryptoCacheRow[] {
  return approvedCryptoEtps().map((s) => freshRow(s, env, assetType));
}

describe("crypto-cache-sync", () => {
  it("exposes exactly the six approved crypto ETPs from CRYPTO_SYMBOL_MAP", () => {
    expect(approvedCryptoEtps()).toEqual(Object.keys(CRYPTO_SYMBOL_MAP).sort());
    expect(approvedCryptoEtps()).toHaveLength(6);
    for (const s of approvedCryptoEtps()) expect(isApprovedCryptoEtp(s)).toBe(true);
    expect(isApprovedCryptoEtp("BTC-USD")).toBe(false);
  });

  it("reports ok when every approved ETP has a fresh, correctly-typed row", () => {
    const report = validateCryptoCacheSync({
      env: "sim",
      cacheRows: fullSnapshot("sim"),
      now: NOW,
    });
    expect(report.ok).toBe(true);
    expect(report.drift.missing).toEqual([]);
    expect(report.drift.wrongAssetType).toEqual([]);
    expect(report.drift.stale).toEqual([]);
    expect(report.drift.unknown).toEqual([]);
    expect(report.summary).toMatch(/in sync/);
  });

  it("accepts every allowed asset type", () => {
    for (const t of CRYPTO_ALLOWED_SAXO_ASSET_TYPES) {
      const report = validateCryptoCacheSync({
        env: "sim",
        cacheRows: fullSnapshot("sim", t),
        now: NOW,
      });
      expect(report.ok, `asset_type=${t}`).toBe(true);
    }
  });

  it("flags missing approved ETPs", () => {
    const rows = fullSnapshot("sim").filter(
      (r) => r.symbol !== "BTCE.DE" && r.symbol !== "HODL.SW",
    );
    const report = validateCryptoCacheSync({ env: "sim", cacheRows: rows, now: NOW });
    expect(report.ok).toBe(false);
    expect(report.drift.missing).toEqual(["BTCE.DE", "HODL.SW"]);
    expect(report.summary).toMatch(/missing=BTCE\.DE,HODL\.SW/);
  });

  it("flags wrong asset_type (e.g. CfdOnEtp, Stock, empty)", () => {
    const rows = fullSnapshot("sim");
    rows[0] = { ...rows[0], asset_type: "CfdOnEtp" };
    rows[1] = { ...rows[1], asset_type: "Stock" };
    rows[2] = { ...rows[2], asset_type: null };
    const report = validateCryptoCacheSync({ env: "sim", cacheRows: rows, now: NOW });
    expect(report.ok).toBe(false);
    expect(report.drift.wrongAssetType.map((w) => w.symbol).sort()).toEqual(
      [rows[0].symbol, rows[1].symbol, rows[2].symbol].sort(),
    );
  });

  it("flags cache rows older than the 30-day max age", () => {
    const stale = new Date(NOW.getTime() - CRYPTO_CACHE_MAX_AGE_MS - 60_000).toISOString();
    const rows = fullSnapshot("sim");
    rows[3] = { ...rows[3], refreshed_at: stale };
    const report = validateCryptoCacheSync({ env: "sim", cacheRows: rows, now: NOW });
    expect(report.ok).toBe(false);
    expect(report.drift.stale.map((s) => s.symbol)).toEqual([rows[3].symbol]);
    expect(report.drift.stale[0].ageMs).toBeGreaterThan(CRYPTO_CACHE_MAX_AGE_MS);
  });

  it("treats missing refreshed_at as infinitely stale", () => {
    const rows = fullSnapshot("sim");
    rows[0] = { ...rows[0], refreshed_at: null };
    const report = validateCryptoCacheSync({ env: "sim", cacheRows: rows, now: NOW });
    expect(report.ok).toBe(false);
    expect(report.drift.stale.map((s) => s.symbol)).toContain(rows[0].symbol);
  });

  it("flags unknown crypto-tagged rows so renamed ETPs surface", () => {
    const rows = [
      ...fullSnapshot("sim"),
      { symbol: "OBTC.DE", env: "sim", asset_type: "Etp", refreshed_at: FRESH },
      { symbol: "BTC-USD", env: "sim", asset_type: "Etp", refreshed_at: FRESH },
    ];
    const report = validateCryptoCacheSync({ env: "sim", cacheRows: rows, now: NOW });
    expect(report.ok).toBe(false);
    expect(report.drift.unknown.map((u) => u.symbol).sort()).toEqual(["BTC-USD", "OBTC.DE"]);
  });

  it("isolates sim from live snapshots", () => {
    // Full sim coverage — but the caller asked for live, which has nothing.
    const report = validateCryptoCacheSync({
      env: "live",
      cacheRows: fullSnapshot("sim"),
      now: NOW,
    });
    expect(report.ok).toBe(false);
    expect(report.drift.missing).toEqual(approvedCryptoEtps());
  });

  it("summary lists every drift dimension when combined", () => {
    const stale = new Date(NOW.getTime() - CRYPTO_CACHE_MAX_AGE_MS - 1_000).toISOString();
    const rows: CryptoCacheRow[] = [
      // BTCE.DE fresh but wrong type
      { symbol: "BTCE.DE", env: "sim", asset_type: "Stock", refreshed_at: FRESH },
      // ABTC.SW stale
      { symbol: "ABTC.SW", env: "sim", asset_type: "Etp", refreshed_at: stale },
      // BTCW.L fresh + valid
      freshRow("BTCW.L", "sim"),
      // ZETH.SW / ZETH.DE / HODL.SW missing entirely
      // unknown symbol drift
      { symbol: "FOO.XX", env: "sim", asset_type: "Etp", refreshed_at: FRESH },
    ];
    const report = validateCryptoCacheSync({ env: "sim", cacheRows: rows, now: NOW });
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/missing=/);
    expect(report.summary).toMatch(/wrongAssetType=/);
    expect(report.summary).toMatch(/stale=/);
    expect(report.summary).toMatch(/unknown=/);
    expect(report.drift.missing).toEqual(["ZETH.DE", "HODL.SW", "ZETH.SW"]);
  });
});
