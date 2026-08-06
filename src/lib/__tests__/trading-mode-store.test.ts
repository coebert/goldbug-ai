import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  readCachedTradingMode,
  writeCachedTradingMode,
  clearCachedTradingMode,
  styleFromRiskConfig,
  resolveTradingMode,
  TRADING_MODE_EVENT,
} from "../trading-mode-store";

// The suite runs in a node environment, so stand up the smallest browser-ish
// surface the store touches: localStorage plus an event dispatcher.
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
}

const storage = new MemoryStorage();
const events: { type: string; detail: unknown }[] = [];
const fakeWindow = {
  localStorage: storage as unknown as Storage,
  dispatchEvent: (e: Event) => {
    events.push({ type: e.type, detail: (e as CustomEvent).detail });
    return true;
  },
};

vi.stubGlobal("window", fakeWindow);
if (typeof globalThis.CustomEvent === "undefined") {
  // Node 18 exposes CustomEvent; guard for older runtimes.
  vi.stubGlobal(
    "CustomEvent",
    class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  );
}

beforeEach(() => {
  storage.clear();
  events.length = 0;
});

afterAll(() => vi.unstubAllGlobals());

describe("trading-mode-store", () => {
  it("round-trips a mode per portfolio", () => {
    writeCachedTradingMode("p1", "swing");
    writeCachedTradingMode("p2", "position");
    expect(readCachedTradingMode("p1")).toBe("swing");
    expect(readCachedTradingMode("p2")).toBe("position");
  });

  it("namespaces the storage key", () => {
    writeCachedTradingMode("p1", "swing");
    expect(storage.getItem("aegis.trading-mode.p1")).toBe("swing");
  });

  it("returns null for unknown portfolios", () => {
    expect(readCachedTradingMode("nope")).toBeNull();
  });

  it("rejects junk written by an older build", () => {
    storage.setItem("aegis.trading-mode.p1", "daytrade");
    expect(readCachedTradingMode("p1")).toBeNull();
  });

  it("ignores an empty portfolio id instead of writing a stray key", () => {
    writeCachedTradingMode("", "swing");
    expect(storage.length).toBe(0);
    expect(readCachedTradingMode("")).toBeNull();
  });

  it("clears a cached mode", () => {
    writeCachedTradingMode("p1", "swing");
    clearCachedTradingMode("p1");
    expect(readCachedTradingMode("p1")).toBeNull();
  });

  it("notifies same-tab listeners on write", () => {
    writeCachedTradingMode("p1", "swing");
    expect(events).toEqual([
      { type: TRADING_MODE_EVENT, detail: { portfolioId: "p1", style: "swing" } },
    ]);
  });

  it("survives storage throwing (private mode / quota)", () => {
    const boom = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(() => writeCachedTradingMode("p1", "swing")).not.toThrow();
    boom.mockRestore();
    const readBoom = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readCachedTradingMode("p1")).toBeNull();
    readBoom.mockRestore();
  });

  it("reads the style off a raw risk config", () => {
    expect(styleFromRiskConfig({ trading_style: "swing" })).toBe("swing");
    expect(styleFromRiskConfig({ trading_style: "position" })).toBe("position");
    expect(styleFromRiskConfig({ trading_style: "scalp" })).toBeNull();
    expect(styleFromRiskConfig({})).toBeNull();
    expect(styleFromRiskConfig(null)).toBeNull();
    expect(styleFromRiskConfig(undefined)).toBeNull();
  });
});

describe("resolveTradingMode", () => {
  it("prefers the server value over any cached choice", () => {
    expect(resolveTradingMode("position", "swing")).toBe("position");
    expect(resolveTradingMode("swing", "position")).toBe("swing");
  });

  it("falls back to the cache while the server value is unknown", () => {
    expect(resolveTradingMode(null, "swing")).toBe("swing");
  });

  it("defaults to position when nothing is known", () => {
    expect(resolveTradingMode(null, null)).toBe("position");
  });
});
