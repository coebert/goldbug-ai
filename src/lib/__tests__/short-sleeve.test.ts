import { describe, it, expect } from "vitest";
import {
  SHORT_PROXIES,
  SHORT_PROXY_MAX_HOLD_DAYS,
  isShortProxy,
  shortProxyMeta,
  shortProxyForUnderlying,
  splitExposure,
  gateShortSleeveBuy,
  netAwareInvestedValue,
  shortProxyStaleHold,
  formatShortSleeveBlock,
} from "@/lib/short-sleeve";

const base = {
  nav: 10_000,
  spendableCash: 10_000,
  longValue: 0,
  shortValue: 0,
  proposedSpend: 1_000,
  maxSleevePct: 0.5,
  enabled: true,
};

describe("short proxies", () => {
  it("only exposes cash-tradeable inverse ETFs", () => {
    expect(SHORT_PROXIES.length).toBeGreaterThan(0);
    for (const p of SHORT_PROXIES) {
      expect(p.symbol.endsWith(".L")).toBe(true); // LSE/UCITS, GBP settled
      expect(p.exposure).toMatch(/-1x/);
    }
  });

  it("identifies proxies case-insensitively", () => {
    expect(isShortProxy("xsps.l")).toBe(true);
    expect(isShortProxy("AAPL")).toBe(false);
    expect(isShortProxy(null)).toBe(false);
    expect(shortProxyMeta("XUKS.L")?.dailyReset).toBe(true);
  });

  it("maps an underlying to the right proxy", () => {
    expect(shortProxyForUnderlying("SPY")?.symbol).toBe("XSPS.L");
    expect(shortProxyForUnderlying("ISF.L")?.symbol).toBe("XUKS.L");
    expect(shortProxyForUnderlying("NVDA")).toBeNull();
  });
});

describe("splitExposure", () => {
  it("separates long book from short sleeve", () => {
    const e = splitExposure(
      [
        { symbol: "AAPL", value: 4_000 },
        { symbol: "ISF.L", value: 2_000 },
        { symbol: "XSPS.L", value: 1_000 },
      ],
      10_000,
    );
    expect(e.longValue).toBe(6_000);
    expect(e.shortValue).toBe(1_000);
    expect(e.grossValue).toBe(7_000);
    expect(e.netValue).toBe(5_000);
    expect(e.grossPctNav).toBeCloseTo(0.7);
    expect(e.netPctNav).toBeCloseTo(0.5);
  });

  it("tolerates zero NAV without dividing by zero", () => {
    const e = splitExposure([{ symbol: "AAPL", value: 100 }], 0);
    expect(e.grossPctNav).toBe(0);
  });
});

describe("gateShortSleeveBuy — never stakes money the account lacks", () => {
  it("allows a normal cash-funded short buy", () => {
    const v = gateShortSleeveBuy(base);
    expect(v.ok).toBe(true);
    expect(v.allowedSpend).toBe(1_000);
  });

  it("refuses everything when shorts are disabled", () => {
    const v = gateShortSleeveBuy({ ...base, enabled: false });
    expect(v.ok).toBe(false);
    expect(v.allowedSpend).toBe(0);
    expect(v.rejected).toMatch(/disabled/);
  });

  it("caps the spend at spendable cash — shorts are never borrowed", () => {
    const v = gateShortSleeveBuy({ ...base, spendableCash: 250, proposedSpend: 5_000 });
    expect(v.allowedSpend).toBe(250);
    expect(v.note).toMatch(/cash-funded/);
  });

  it("blocks entirely when there is no spendable cash", () => {
    const v = gateShortSleeveBuy({ ...base, spendableCash: 0 });
    expect(v.ok).toBe(false);
    expect(v.rejected).toMatch(/cash-funded|no spendable cash/);
  });

  it("caps the sleeve at its share of NAV", () => {
    const v = gateShortSleeveBuy({ ...base, shortValue: 4_500, proposedSpend: 2_000 });
    expect(v.allowedSpend).toBe(500); // 50% of 10k minus 4.5k already short
    const full = gateShortSleeveBuy({ ...base, shortValue: 5_000 });
    expect(full.ok).toBe(false);
    expect(full.rejected).toMatch(/sleeve full/);
  });

  it("enforces the hard gross cap: longs + shorts never exceed NAV", () => {
    const v = gateShortSleeveBuy({ ...base, longValue: 9_500, proposedSpend: 1_000 });
    expect(v.allowedSpend).toBe(500);
    const none = gateShortSleeveBuy({ ...base, longValue: 10_000 });
    expect(none.ok).toBe(false);
    expect(none.rejected).toMatch(/gross exposure cap/);
  });

  it("keeps gross ≤ NAV across a sequence of buys", () => {
    let long = 6_000;
    let short = 0;
    let cash = 4_000;
    for (let i = 0; i < 10; i++) {
      const v = gateShortSleeveBuy({
        ...base,
        longValue: long,
        shortValue: short,
        spendableCash: cash,
        proposedSpend: 1_000,
      });
      if (!v.ok) break;
      short += v.allowedSpend;
      cash -= v.allowedSpend;
      expect(long + short).toBeLessThanOrEqual(base.nav + 1e-9);
      expect(cash).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(long + short).toBeLessThanOrEqual(base.nav + 1e-9);
  });

  it("refuses when NAV is unknown", () => {
    const v = gateShortSleeveBuy({ ...base, nav: 0 });
    expect(v.ok).toBe(false);
  });
});

describe("net-aware sizing", () => {
  it("treats the short sleeve as an offset, floored at zero", () => {
    expect(netAwareInvestedValue(6_000, 1_000)).toBe(5_000);
    expect(netAwareInvestedValue(1_000, 4_000)).toBe(0);
  });
});

describe("daily-reset hold review", () => {
  it("flags stale daily-reset holds only past the horizon", () => {
    expect(shortProxyStaleHold("XSPS.L", SHORT_PROXY_MAX_HOLD_DAYS).stale).toBe(false);
    const stale = shortProxyStaleHold("XSPS.L", SHORT_PROXY_MAX_HOLD_DAYS + 1);
    expect(stale.stale).toBe(true);
    expect(stale.note).toMatch(/compounding drag/);
    expect(shortProxyStaleHold("AAPL", 400).stale).toBe(false);
  });
});

describe("prompt block", () => {
  it("states the caps and current split when enabled", () => {
    const block = formatShortSleeveBlock({
      enabled: true,
      nav: 10_000,
      exposure: splitExposure(
        [{ symbol: "AAPL", value: 5_000 }, { symbol: "XSPS.L", value: 1_000 }],
        10_000,
      ),
      maxSleevePct: 0.5,
      currency: "GBP",
    });
    expect(block).toMatch(/no margin, no borrowing/);
    expect(block).toContain("XSPS.L");
    expect(block).toMatch(/short 10% NAV/);
    expect(block).toMatch(/net 40%/);
  });

  it("tells the AI to stay long-only when disabled", () => {
    const block = formatShortSleeveBlock({
      enabled: false,
      nav: 10_000,
      exposure: splitExposure([], 10_000),
      maxSleevePct: 0.5,
      currency: "GBP",
    });
    expect(block).toMatch(/long-only/);
  });
});
