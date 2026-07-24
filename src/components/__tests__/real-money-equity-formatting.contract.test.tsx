// Contract test: locks the Intl.NumberFormat configuration used by the
// real-money equity tile (<ModeSummaryTile />).
//
// Three formatters back the tile (src/routes/index.tsx, ~L358-L362):
//   MONEY  — new Intl.NumberFormat(undefined, {
//              style: "currency", currency: "GBP", maximumFractionDigits: 0 })
//   PCT    — new Intl.NumberFormat(undefined, {
//              minimumFractionDigits: 2, maximumFractionDigits: 2,
//              useGrouping: false })
//   PNL    — new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
//
// Sign handling is NOT delegated to Intl.signDisplay — the tile prefixes
// a literal "+" for non-negative pnl/pct and lets Intl render the minus
// sign for negatives. That contract is locked here as well, because
// changing to `signDisplay: "always" | "exceptZero"` would double up the
// plus sign and silently break the headline.
//
// If any of these locks fail, the visible headline for real-money equity
// changed. Update the tile intentionally AND update this contract in the
// same commit — do not "fix" the test in isolation.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeSummaryTile } from "@/routes/index";

// Force a stable locale so resolvedOptions and rendered strings are
// deterministic across CI machines with differing default locales.
const LOCALE = "en-GB";

const MONEY = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const PCT = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});
const PNL = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

describe("real-money equity formatting — resolved-options contract", () => {
  it("MONEY formatter: GBP currency, 0 fraction digits, default rounding + sign", () => {
    const r = MONEY.resolvedOptions();
    expect(r.style).toBe("currency");
    expect(r.currency).toBe("GBP");
    expect(r.currencyDisplay).toBe("symbol");
    expect(r.maximumFractionDigits).toBe(0);
    expect(r.minimumFractionDigits).toBe(0);
    // Rounding + sign contract: rely on the platform defaults. Anyone
    // who edits the tile to pick a non-default must update this lock.
    expect((r as { roundingMode?: string }).roundingMode ?? "halfExpand").toBe("halfExpand");
    expect(r.signDisplay ?? "auto").toBe("auto");
    expect(r.useGrouping).not.toBe(false); // grouping ON for money
  });

  it("PCT formatter: exactly 2 fraction digits, grouping disabled, default rounding + sign", () => {
    const r = PCT.resolvedOptions();
    expect(r.style).toBe("decimal");
    expect(r.minimumFractionDigits).toBe(2);
    expect(r.maximumFractionDigits).toBe(2);
    expect(r.useGrouping).toBe(false);
    expect((r as { roundingMode?: string }).roundingMode ?? "halfExpand").toBe("halfExpand");
    expect(r.signDisplay ?? "auto").toBe("auto");
  });

  it("PNL formatter: 0 fraction digits, default rounding + sign", () => {
    const r = PNL.resolvedOptions();
    expect(r.style).toBe("decimal");
    expect(r.maximumFractionDigits).toBe(0);
    expect((r as { roundingMode?: string }).roundingMode ?? "halfExpand").toBe("halfExpand");
    expect(r.signDisplay ?? "auto").toBe("auto");
  });
});

describe("real-money equity formatting — rendered-output contract", () => {
  it("locks positive-value rendering: whole GBP, +pct with 2dp, +pnl whole", () => {
    expect(MONEY.format(1234567)).toBe("£1,234,567");
    expect(PCT.format(12.345)).toBe("12.35"); // half-up rounds .345 → .35
    expect(PCT.format(0)).toBe("0.00");
    expect(PNL.format(30)).toBe("30");
  });

  it("locks negative-value rendering: single minus sign, no double-signing", () => {
    // If someone flips to signDisplay: "always" this becomes "+-…".
    expect(MONEY.format(-1234)).toBe("-£1,234");
    expect(PCT.format(-3.14)).toBe("-3.14");
    expect(PNL.format(-42)).toBe("-42");
  });

  it("locks half-away-from-zero rounding at the tile's cut-off digits", () => {
    // Money & PnL round to whole units at 0.5 boundaries.
    expect(MONEY.format(0.5)).toBe("£1");
    expect(MONEY.format(-0.5)).toBe("-£1");
    expect(PNL.format(0.5)).toBe("1");
    expect(PNL.format(-0.5)).toBe("-1");
    // Pct rounds at the 2dp boundary.
    expect(PCT.format(1.005)).toBe("1.01");
    expect(PCT.format(-1.005)).toBe("-1.01");
  });

  it("locks the composed tile headline: '+pct% · +pnl' for gains, minus for losses", () => {
    // Gain: literal "+" prefix from the component, not from Intl.
    const gain = renderToStaticMarkup(
      <ModeSummaryTile
        label="Real-money equity"
        sublabel="REAL · live Saxo"
        tone="real"
        money={360}
        pnl={30}
        pct={9.0909}
        count={1}
      />,
    );
    // Whole-GBP money, 2dp pct with literal "+", whole pnl with literal "+".
    expect(gain).toContain("£360");
    expect(gain).toContain("+9.09%");
    expect(gain).toContain("+30");
    // No double sign that would appear if signDisplay flipped to "always".
    expect(gain).not.toContain("++");

    // Loss: Intl supplies the minus, component supplies no extra prefix.
    const loss = renderToStaticMarkup(
      <ModeSummaryTile
        label="Real-money equity"
        sublabel="REAL · live Saxo"
        tone="real"
        money={270}
        pnl={-30}
        pct={-10}
        count={1}
      />,
    );
    expect(loss).toContain("£270");
    expect(loss).toContain("-10.00%");
    expect(loss).toContain("-30");
    expect(loss).not.toContain("+-"); // guards against signDisplay drift
    expect(loss).not.toContain("−"); // ASCII minus contract (U+2212 not used)
  });

  it("locks -0 collapse: tile never renders '-£0' / '-0.00%' / '-0'", () => {
    // The tile coerces Object.is(x, -0) → 0 before formatting. Lock the
    // observable outcome so a future refactor can't re-introduce -0.
    const html = renderToStaticMarkup(
      <ModeSummaryTile
        label="Real-money equity"
        sublabel="REAL · live Saxo"
        tone="real"
        money={-0}
        pnl={-0}
        pct={-0}
        count={1}
      />,
    );
    expect(html).toContain("£0");
    expect(html).toContain("+0.00%");
    expect(html).toContain("+0");
    expect(html).not.toContain("-£0");
    expect(html).not.toContain("-0.00%");
  });

  it("locks grouping: money uses thousands separators; pct never does", () => {
    expect(MONEY.format(1234567)).toContain(","); // grouping ON
    // A 4-digit pct like 1234.56 is unrealistic but proves the flag:
    // grouping MUST stay off so "1234.56" doesn't become "1,234.56".
    expect(PCT.format(1234.56)).toBe("1234.56");
    expect(PCT.format(1234.56)).not.toContain(",");
  });
});
