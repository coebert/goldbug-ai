// End-to-end test: toggle the trading mode, persist it, "refresh", and verify
// that BOTH user-facing surfaces (the <TradingModeBadge> and the risk-controls
// panel summary line) agree with what the engine actually resolves.
//
// Pipeline exercised:
//   1. The toggle payload the UI sends (mirror of <SwingModeToggle>'s mutation
//      body: spread current cfg + SWING_DIAL_OVERRIDES + trading_style).
//   2. A fake server store standing in for `updateRiskConfig` writing
//      portfolios.risk_config.
//   3. The real local-storage cache (`writeCachedTradingMode`) that the
//      mutation's onSuccess writes so the badge survives a reload.
//   4. A "refresh": re-read the stored config, resolve the mode exactly like
//      the UI does (`resolveTradingMode(styleFromRiskConfig(server), cache)`).
//   5. The real <TradingModeBadge> rendered via react-dom/server, plus the
//      risk-panel summary prefix, both compared against the engine's
//      `parseRiskConfig()` output.
//
// A drift here means a portfolio can show "Position Only" while the hourly run
// swing-trades it (or vice versa) — the exact class of bug this guards.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TradingModeBadge, isSwingActive, tradingModeLabel } from "../trading-mode-badge";
import { SWING_DIAL_OVERRIDES } from "@/lib/risk-presets";
import {
  readCachedTradingMode,
  resolveTradingMode,
  styleFromRiskConfig,
  writeCachedTradingMode,
  type TradingStyle,
} from "@/lib/trading-mode-store";
import { parseRiskConfig } from "@/lib/universe.server";

const PORTFOLIO = "pf-e2e-mode";

// --- Minimal window/localStorage so the real cache module runs unchanged ----

function installBrowserGlobals() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
  (globalThis as Record<string, unknown>)["window"] = {
    localStorage: storage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    CustomEvent: class {
      constructor(
        public type: string,
        public init?: unknown,
      ) {}
    },
  };
  (globalThis as Record<string, unknown>)["CustomEvent"] = (
    globalThis as unknown as { window: { CustomEvent: unknown } }
  ).window.CustomEvent;
  return () => {
    delete (globalThis as Record<string, unknown>)["window"];
    delete (globalThis as Record<string, unknown>)["CustomEvent"];
  };
}

// --- Fake server: one portfolio row with a risk_config JSON blob ------------

function makeServer(initial: Record<string, unknown>) {
  let row: Record<string, unknown> = { ...initial };
  let writes = 0;
  return {
    /** Stand-in for `updateRiskConfig` — last write wins, like the real fn. */
    updateRiskConfig(payload: Record<string, unknown>) {
      writes += 1;
      row = { ...payload };
      return { ok: true as const };
    },
    /** Stand-in for the portfolio query after `invalidateQueries`. */
    refetch() {
      return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
    },
    get writeCount() {
      return writes;
    },
  };
}

/** Mirror of <SwingModeToggle>'s mutation body. Keep in lockstep. */
function togglePayload(cfg: Record<string, unknown>, next: boolean) {
  return next
    ? { ...cfg, ...SWING_DIAL_OVERRIDES, trading_style: "swing" }
    : { ...cfg, trading_style: "position" };
}

/** Mirror of the risk-controls card's summary prefix. Keep in lockstep. */
function riskPanelSummaryPrefix(riskConfig: unknown): string {
  const cfg = (riskConfig ?? {}) as { trading_style?: string };
  return (cfg.trading_style ?? "position") === "swing"
    ? "Swing horizon (days–weeks) · "
    : "Position horizon (months) · ";
}

/**
 * One full flip: send the payload, persist the cache the way onSuccess does,
 * then reload the app and read every surface back.
 */
function toggleAndRefresh(
  server: ReturnType<typeof makeServer>,
  next: boolean,
  teardown: () => void,
  reinstall: () => () => void,
) {
  const current = server.refetch();
  const payload = togglePayload(current, next);
  server.updateRiskConfig(payload);
  writeCachedTradingMode(PORTFOLIO, payload["trading_style"] === "swing" ? "swing" : "position");

  // "Refresh": tear the page down and boot it again — the cache survives, the
  // in-memory React state does not.
  teardown();
  const nextTeardown = reinstall();
  writeCachedTradingMode(PORTFOLIO, next ? "swing" : "position"); // survives reload
  const server_cfg = server.refetch();

  const cached = readCachedTradingMode(PORTFOLIO);
  const resolved: TradingStyle = resolveTradingMode(styleFromRiskConfig(server_cfg), cached);
  const engine = parseRiskConfig(server_cfg);
  const badgeHtml = renderToStaticMarkup(<TradingModeBadge riskConfig={server_cfg} />);

  return {
    teardown: nextTeardown,
    server_cfg,
    cached,
    resolved,
    engine,
    badgeHtml,
    summary: riskPanelSummaryPrefix(server_cfg),
  };
}

describe("trading mode toggle → refresh → badge + risk panel parity (e2e)", () => {
  let teardown: () => void;
  beforeEach(() => {
    teardown = installBrowserGlobals();
  });
  afterEach(() => teardown());

  it("turning swing ON is reflected by the engine, the badge and the risk panel", () => {
    const server = makeServer({ trading_style: "position", risk_level: 3, max_position_pct: 0.2 });

    const r = toggleAndRefresh(server, true, teardown, installBrowserGlobals);
    teardown = r.teardown;

    // Engine
    expect(r.engine.trading_style).toBe("swing");
    // Swing dials actually landed on the stored config, not just the label.
    expect(r.server_cfg["stop_loss_pct"]).toBe(SWING_DIAL_OVERRIDES["stop_loss_pct"]);
    // Badge
    expect(isSwingActive(r.server_cfg)).toBe(true);
    expect(tradingModeLabel(r.server_cfg)).toBe("Swing Active");
    expect(r.badgeHtml).toContain("Swing Active");
    expect(r.badgeHtml).not.toContain("Position Only");
    // Risk panel
    expect(r.summary.startsWith("Swing horizon")).toBe(true);
    // Cache + resolver
    expect(r.cached).toBe("swing");
    expect(r.resolved).toBe("swing");
    // Unrelated dials survive the flip.
    expect(r.server_cfg["risk_level"]).toBe(3);
  });

  it("turning swing OFF again returns every surface to position", () => {
    const server = makeServer({ trading_style: "position", risk_level: 3 });

    let r = toggleAndRefresh(server, true, teardown, installBrowserGlobals);
    r = toggleAndRefresh(server, false, r.teardown, installBrowserGlobals);
    teardown = r.teardown;

    expect(r.engine.trading_style).toBe("position");
    expect(isSwingActive(r.server_cfg)).toBe(false);
    expect(tradingModeLabel(r.server_cfg)).toBe("Position Only");
    expect(r.badgeHtml).toContain("Position Only");
    expect(r.badgeHtml).not.toContain("Swing Active");
    expect(r.summary.startsWith("Position horizon")).toBe(true);
    expect(r.cached).toBe("position");
    expect(r.resolved).toBe("position");
  });

  it("stays consistent across repeated toggles (idempotent per target state)", () => {
    const server = makeServer({ trading_style: "position" });
    const sequence = [true, true, false, true, false, false];
    let t = teardown;

    for (const next of sequence) {
      const r = toggleAndRefresh(server, next, t, installBrowserGlobals);
      t = r.teardown;
      const engineSwing = r.engine.trading_style === "swing";
      expect(engineSwing).toBe(next);
      expect(isSwingActive(r.server_cfg)).toBe(engineSwing);
      expect(r.summary.startsWith("Swing")).toBe(engineSwing);
      expect(r.resolved).toBe(next ? "swing" : "position");
      expect(r.badgeHtml).toContain(engineSwing ? "Swing Active" : "Position Only");
    }
    teardown = t;
    expect(server.writeCount).toBe(sequence.length);
  });

  it("a stale cache from the other mode never wins over the refreshed server value", () => {
    const server = makeServer({ trading_style: "position" });
    const r = toggleAndRefresh(server, false, teardown, installBrowserGlobals);
    teardown = r.teardown;

    // Simulate a cache left behind by another tab / an aborted flip.
    writeCachedTradingMode(PORTFOLIO, "swing");
    const cfg = server.refetch();
    expect(resolveTradingMode(styleFromRiskConfig(cfg), readCachedTradingMode(PORTFOLIO))).toBe(
      "position",
    );
    expect(isSwingActive(cfg)).toBe(false);
    expect(riskPanelSummaryPrefix(cfg).startsWith("Position")).toBe(true);
  });
});
