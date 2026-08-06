// Parity guard: whatever the engine resolves `trading_style` to must be what
// the badge and the risk-panel summary line tell the user.
//
// The engine's source of truth is `parseTradingStyle()` (pure, shared by
// `parseRiskConfig`). The UI has two independent readers — `isSwingActive()` /
// `tradingModeLabel()` behind <TradingModeBadge>, and the risk-controls card's
// "Swing horizon / Position horizon" description. If any of them drifts, a
// portfolio can show "Position Only" while the hourly run swing-trades it.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TradingModeBadge,
  isSwingActive,
  tradingModeLabel,
} from "../trading-mode-badge";
import { parseTradingStyle } from "@/lib/trading-style";
import { styleFromRiskConfig, resolveTradingMode } from "@/lib/trading-mode-store";

/** Mirror of the risk-controls card's summary prefix (src/components/risk-controls-card.tsx). */
function riskPanelSummaryPrefix(riskConfig: unknown): string {
  const cfg = (riskConfig ?? {}) as { trading_style?: string };
  return (cfg.trading_style ?? "position") === "swing"
    ? "Swing horizon (days–weeks) · "
    : "Position horizon (months) · ";
}

// Every shape a stored risk_config has realistically taken, plus junk.
const CONFIGS: Array<[label: string, cfg: unknown]> = [
  ["swing", { trading_style: "swing" }],
  ["position", { trading_style: "position" }],
  ["missing style", { stop_loss_pct: 0.06 }],
  ["empty object", {}],
  ["null", null],
  ["undefined", undefined],
  ["unknown style", { trading_style: "scalp" }],
  ["wrong case", { trading_style: "Swing" }],
  ["non-string style", { trading_style: 1 }],
  ["swing with extra dials", { trading_style: "swing", max_hold_days: 20, stop_loss_pct: 0.06 }],
];

describe("trading mode parity — engine vs UI", () => {
  it.each(CONFIGS)("badge agrees with the engine for %s", (_label, cfg) => {
    const engineSwing = parseTradingStyle((cfg as { trading_style?: unknown } | null)?.trading_style) === "swing";
    expect(isSwingActive(cfg)).toBe(engineSwing);
    expect(tradingModeLabel(cfg)).toBe(engineSwing ? "Swing Active" : "Position Only");
  });

  it.each(CONFIGS)("risk-panel summary agrees with the engine for %s", (_label, cfg) => {
    const engineSwing = parseTradingStyle((cfg as { trading_style?: unknown } | null)?.trading_style) === "swing";
    expect(riskPanelSummaryPrefix(cfg).startsWith("Swing")).toBe(engineSwing);
    // …and with the badge, so the two surfaces can never disagree.
    expect(riskPanelSummaryPrefix(cfg).startsWith("Swing")).toBe(isSwingActive(cfg));
  });

  it.each(CONFIGS)("rendered badge markup matches the engine for %s", (_label, cfg) => {
    const engineSwing = parseTradingStyle((cfg as { trading_style?: unknown } | null)?.trading_style) === "swing";
    const html = renderToStaticMarkup(<TradingModeBadge riskConfig={cfg} />);
    // Compact phone label + full label are both rendered; check both agree.
    expect(html).toContain(engineSwing ? ">Swing<" : ">Position<");
    expect(html).toContain(engineSwing ? "Swing Active" : "Position Only");
    expect(html).not.toContain(engineSwing ? "Position Only" : "Swing Active");
  });

  it("local-storage cache can never override a loaded server style", () => {
    // Server says position, a stale cache says swing → the engine's value wins.
    expect(resolveTradingMode(styleFromRiskConfig({ trading_style: "position" }), "swing")).toBe(
      "position",
    );
    expect(resolveTradingMode(styleFromRiskConfig({ trading_style: "swing" }), "position")).toBe(
      "swing",
    );
    // Only while the server value is unknown does the cache fill the gap.
    expect(resolveTradingMode(styleFromRiskConfig({}), "swing")).toBe("swing");
    expect(resolveTradingMode(null, null)).toBe("position");
  });

  it("an unparseable style degrades to position everywhere, never to swing", () => {
    for (const junk of ["", "SWING ", "long", 0, false, [], {}]) {
      const cfg = { trading_style: junk };
      expect(parseTradingStyle(junk)).toBe("position");
      expect(isSwingActive(cfg)).toBe(false);
      expect(riskPanelSummaryPrefix(cfg).startsWith("Position")).toBe(true);
    }
  });
});
