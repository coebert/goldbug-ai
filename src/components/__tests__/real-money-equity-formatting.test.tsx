// Verify displayed real-money equity values in the dashboard tile are
// rounded/formatted consistently with the underlying stored snapshot
// totals: whole GBP for the headline, 2dp for the percent, whole GBP for
// the PnL delta, and always with the GBP currency symbol.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeSummaryTile } from "@/routes/index";

// Reference formatters — MUST match ModeSummaryTile's Intl config exactly
// (src/routes/index.tsx lines ~362, 366). If the tile changes format,
// these tests will fail and force the update.
const gbpWhole = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const numWhole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function render(money: number, pnl: number, pct: number) {
  return renderToStaticMarkup(
    <ModeSummaryTile
      label="Real-money equity"
      sublabel="REAL · live Saxo"
      tone="real"
      money={money}
      pnl={pnl}
      pct={pct}
      count={1}
    />,
  );
}

describe("real-money equity tile — rounding & formatting", () => {
  it("headline money is formatted as GBP currency with zero decimals", () => {
    const stored = 300.46;
    const html = render(stored, 0.46, 0.153);
    expect(html).toContain(gbpWhole.format(stored)); // "£300"
    // Never emit the raw 2dp decimal for the headline value.
    expect(html).not.toContain("300.46");
    expect(html).not.toContain("300.5");
  });

  it("rounds halves according to Intl.NumberFormat (banker/half-to-even may apply)", () => {
    // Whatever Intl produces for 300.5 IS what the tile must show — the
    // point is consistency with the shared formatter, not a specific rule.
    const stored = 300.5;
    const html = render(stored, 0.5, 0.166);
    expect(html).toContain(gbpWhole.format(stored));
  });

  it("negative equity is rendered with a leading minus in the currency format", () => {
    const stored = -125.4;
    const html = render(stored, -20, -13.79);
    expect(html).toContain(gbpWhole.format(stored));
    // Locale-dependent minus sign; the formatter output IS the source of truth.
  });

  it("zero equity uses the same GBP formatter (never bare '0')", () => {
    const html = render(0, 0, 0);
    expect(html).toContain(gbpWhole.format(0)); // "£0"
  });

  it("large stored totals are grouped by the locale formatter", () => {
    const stored = 12_345.67;
    const html = render(stored, 45, 0.365);
    // Formatter inserts a thousands separator (locale-dependent — comma in
    // en-* locales, space in fr-*). Compare against the formatter itself.
    expect(html).toContain(gbpWhole.format(stored));
    // Raw ungrouped digits must NOT appear as the headline.
    expect(html).not.toContain(">12345<");
  });

  it("percent change is rendered to exactly 2 decimal places", () => {
    const html = render(300.46, 0.46, 0.15333);
    // pnl >= 0 branch prefixes with "+"
    expect(html).toContain("+0.15%");
    expect(html).not.toContain("0.153%");
    expect(html).not.toContain("0.1533%");
  });

  it("percent change keeps trailing zeros to reach 2dp", () => {
    const html = render(500, 25, 5);
    expect(html).toContain("+5.00%");
  });

  it("negative percent is rendered without a leading '+' and with 2dp", () => {
    const html = render(280, -20, -6.6666);
    expect(html).toContain("-6.67%");
    expect(html).not.toContain("+-6.67%");
  });

  it("PnL delta is rendered with zero decimals using the shared number formatter", () => {
    const html = render(300.46, 0.46, 0.153);
    // Rounds 0.46 to "0" via maximumFractionDigits: 0.
    expect(html).toContain(`+${numWhole.format(0.46)}`);
    // Precise cash value not shown in the delta chip.
    expect(html).not.toMatch(/\+0\.46/);
  });

  it("large PnL delta is grouped by the locale formatter", () => {
    const html = render(50_000, 1_234.9, 2.53);
    expect(html).toContain(`+${numWhole.format(1_234.9)}`); // "+1,235" in en-*
  });

  it("PnL sign matches the numeric sign consistently for tiny values", () => {
    // Positive branch: prefix "+"; delta rounds to 0 but percent shows sign.
    const posHtml = render(300.01, 0.01, 0.003);
    expect(posHtml).toContain("+0.00%");
    expect(posHtml).toContain(`+${numWhole.format(0.01)}`); // "+0"
    // Negative branch: no "+" prefix; percent is negative.
    const negHtml = render(299.99, -0.01, -0.003);
    expect(negHtml).toContain("-0.00%");
    expect(negHtml).not.toMatch(/\+-?0/);
  });

  it("headline and delta share the same locale — no mixed grouping styles", () => {
    // Both formatters are constructed with `undefined` locale (system
    // default). Rendering the same underlying number through both must
    // produce the same digit substring inside the tile.
    const stored = 9_876;
    const html = render(stored, stored, 100);
    const moneyStr = gbpWhole.format(stored); // e.g. "£9,876"
    const deltaStr = numWhole.format(stored); // e.g. "9,876"
    expect(html).toContain(moneyStr);
    expect(html).toContain(`+${deltaStr}`);
    // The digit portion of the money string must equal the delta string.
    const moneyDigits = moneyStr.replace(/[^\d,\s.]/g, "").trim();
    expect(moneyDigits).toBe(deltaStr);
  });

  it("formatting is idempotent: rendering twice with the same snapshot yields identical HTML", () => {
    const a = render(300.46, 0.46, 0.153);
    const b = render(300.46, 0.46, 0.153);
    expect(a).toBe(b);
  });
});
