import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  readCachedTradingMode,
  writeCachedTradingMode,
  clearCachedTradingMode,
  styleFromRiskConfig,
} from "../../lib/trading-mode-store";
import { useTradingMode } from "../use-trading-mode";

beforeEach(() => {
  window.localStorage.clear();
});

describe("trading-mode-store", () => {
  it("round-trips a mode per portfolio", () => {
    writeCachedTradingMode("p1", "swing");
    writeCachedTradingMode("p2", "position");
    expect(readCachedTradingMode("p1")).toBe("swing");
    expect(readCachedTradingMode("p2")).toBe("position");
  });

  it("returns null for unknown portfolios and junk values", () => {
    expect(readCachedTradingMode("nope")).toBeNull();
    window.localStorage.setItem("aegis.trading-mode.p1", "daytrade");
    expect(readCachedTradingMode("p1")).toBeNull();
  });

  it("clears a cached mode", () => {
    writeCachedTradingMode("p1", "swing");
    clearCachedTradingMode("p1");
    expect(readCachedTradingMode("p1")).toBeNull();
  });

  it("reads the style off a raw risk config", () => {
    expect(styleFromRiskConfig({ trading_style: "swing" })).toBe("swing");
    expect(styleFromRiskConfig({ trading_style: "position" })).toBe("position");
    expect(styleFromRiskConfig({})).toBeNull();
    expect(styleFromRiskConfig(null)).toBeNull();
  });
});

describe("useTradingMode", () => {
  it("defaults to position when nothing is known", () => {
    const { result } = renderHook(() => useTradingMode("p1", null));
    expect(result.current.style).toBe("position");
    expect(result.current.isSwing).toBe(false);
  });

  it("restores the cached mode while the server config is still missing", () => {
    writeCachedTradingMode("p1", "swing");
    const { result } = renderHook(() => useTradingMode("p1", null));
    expect(result.current.isSwing).toBe(true);
  });

  it("lets the server value override a stale cache", () => {
    writeCachedTradingMode("p1", "swing");
    const { result } = renderHook(() => useTradingMode("p1", { trading_style: "position" }));
    expect(result.current.style).toBe("position");
    expect(readCachedTradingMode("p1")).toBe("position");
  });

  it("persists the server value so the next mount starts correct", () => {
    renderHook(() => useTradingMode("p1", { trading_style: "swing" }));
    expect(readCachedTradingMode("p1")).toBe("swing");
    const second = renderHook(() => useTradingMode("p1", null));
    expect(second.result.current.isSwing).toBe(true);
  });

  it("setStyle writes through to storage", () => {
    const { result } = renderHook(() => useTradingMode("p1", null));
    act(() => result.current.setStyle("swing"));
    expect(result.current.isSwing).toBe(true);
    expect(readCachedTradingMode("p1")).toBe("swing");
  });

  it("keeps other surfaces in the same tab in sync", () => {
    const { result } = renderHook(() => useTradingMode("p1", null));
    act(() => writeCachedTradingMode("p1", "swing"));
    expect(result.current.isSwing).toBe(true);
  });

  it("ignores updates for a different portfolio", () => {
    const { result } = renderHook(() => useTradingMode("p1", null));
    act(() => writeCachedTradingMode("p2", "swing"));
    expect(result.current.isSwing).toBe(false);
  });

  it("is inert without a portfolio id", () => {
    const { result } = renderHook(() => useTradingMode(undefined, null));
    act(() => result.current.setStyle("swing"));
    expect(result.current.style).toBe("swing");
    expect(window.localStorage.length).toBe(0);
  });
});
