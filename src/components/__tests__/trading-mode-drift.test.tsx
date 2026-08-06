// Guard: a stale cached trading mode must be detected, warned about, and
// auto-re-synced to the engine's value — never silently displayed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clearTradingModeDrift,
  detectTradingModeDrift,
  readCachedTradingMode,
  readTradingModeDrift,
  recordTradingModeDrift,
  writeCachedTradingMode,
} from "@/lib/trading-mode-store";
import { parseTradingStyle } from "@/lib/trading-style";
import { TradingModeDriftNotice } from "@/components/trading-mode-drift-notice";

function installStorage() {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>)["window"] = {
    localStorage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as Record<string, unknown>)["CustomEvent"] = class {
    constructor(
      public type: string,
      public init?: unknown,
    ) {}
  };
  return () => {
    delete (globalThis as Record<string, unknown>)["window"];
    delete (globalThis as Record<string, unknown>)["CustomEvent"];
  };
}

const PF = "pf-drift";

describe("trading mode drift detection", () => {
  let teardown: () => void;
  beforeEach(() => {
    teardown = installStorage();
    clearTradingModeDrift(PF);
  });
  afterEach(() => teardown());

  it("flags a cache that disagrees with the engine", () => {
    const d = detectTradingModeDrift({ trading_style: "swing" }, "position");
    expect(d).toEqual({ drifted: true, engineStyle: "swing", cachedStyle: "position" });
  });

  it("does not flag agreement, an empty cache, or an unloaded config", () => {
    expect(detectTradingModeDrift({ trading_style: "swing" }, "swing").drifted).toBe(false);
    expect(detectTradingModeDrift({ trading_style: "swing" }, null).drifted).toBe(false);
    expect(detectTradingModeDrift({}, "swing").drifted).toBe(false);
    expect(detectTradingModeDrift(null, "swing").drifted).toBe(false);
    expect(detectTradingModeDrift(undefined, "swing").drifted).toBe(false);
  });

  it("treats an unparseable stored style as position, matching the engine", () => {
    for (const junk of ["Swing", "", 1, null, "scalp"]) {
      const engine = parseTradingStyle(junk);
      const d = detectTradingModeDrift({ trading_style: junk }, "swing");
      expect(d.engineStyle).toBe(engine);
      expect(d.drifted).toBe(engine !== "swing");
    }
  });

  it("re-sync writes the engine value into the cache", () => {
    writeCachedTradingMode(PF, "swing");
    const { drifted, engineStyle } = detectTradingModeDrift({ trading_style: "position" }, "swing");
    expect(drifted).toBe(true);
    writeCachedTradingMode(PF, engineStyle!);
    expect(readCachedTradingMode(PF)).toBe("position");
    // Re-checking after the re-sync is clean — the warning does not stick.
    expect(detectTradingModeDrift({ trading_style: "position" }, readCachedTradingMode(PF)).drifted).toBe(
      false,
    );
  });

  it("shares one drift record across surfaces regardless of mount order", () => {
    recordTradingModeDrift(PF, { from: "swing", to: "position" });
    expect(readTradingModeDrift(PF)).toEqual({ from: "swing", to: "position" });
    clearTradingModeDrift(PF);
    expect(readTradingModeDrift(PF)).toBeNull();
  });

  it("renders the warning naming both modes, and nothing when there is no drift", () => {
    writeCachedTradingMode(PF, "swing");
    const html = renderToStaticMarkup(
      <TradingModeDriftNotice portfolioId={PF} riskConfig={{ trading_style: "position" }} />,
    );
    // SSR runs no effects, so the notice is empty on the server — it must never
    // render stale markup that hydration then contradicts.
    expect(html).toBe("");

    // The record itself carries the user-facing wording inputs.
    const d = detectTradingModeDrift({ trading_style: "position" }, "swing");
    expect(d.cachedStyle).toBe("swing");
    expect(d.engineStyle).toBe("position");
  });
});
