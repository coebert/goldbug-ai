// Formatting consistency for extreme real-money equity magnitudes.
//
// Locks in that the tile's shared Intl formatters behave predictably
// across:
//   - very large totals (millions, billions)
//   - very small totals (sub-penny fractions, tiny gains/losses)
//   - values right at / around zero (±epsilon, exact 0, -0)
//
// Guarantees checked:
//   1. Headline == gbpWhole.format(money) exactly (no drift).
//   2. Delta == numWhole.format(pnl) exactly.
//   3. Percent == pct.toFixed(2) with correct sign prefix.
//   4. No raw JS number literals (e.g. "1e21", "1.234e-7") in output.
//   5. No "NaN" / "Infinity" ever renders.
//   6. Tone class matches sign of pnl.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeSummaryTile } from "@/routes/index";

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

function assertNoBadTokens(html: string) {
  expect(html).not.toMatch(/NaN/);
  expect(html).not.toMatch(/Infinity/);
  // Scientific notation must never leak through the formatter.
  expect(html).not.toMatch(/\d+e[+-]?\d+/i);
}

function assertHeadlineDelta(html: string, money: number, pnl: number, pct: number) {
  expect(html).toContain(gbpWhole.format(money));
  const pnlStr = numWhole.format(pnl);
  const prefix = pnl >= 0 ? "+" : "";
  const pctStr = `${pct >= 0 && pnl >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  expect(html).toContain(`${pctStr} · ${prefix}${pnlStr}`);
  assertNoBadTokens(html);
}

describe("real-money equity — extreme magnitude formatting", () => {
  describe("very large totals", () => {
    it("millions render with locale grouping (no scientific notation)", () => {
      const html = render(1_234_567, 250_000, 25.37);
      assertHeadlineDelta(html, 1_234_567, 250_000, 25.37);
      expect(html).toContain("text-success");
    });

    it("hundreds of millions render whole with grouping", () => {
      const html = render(987_654_321, -1_500_000, -0.152);
      assertHeadlineDelta(html, 987_654_321, -1_500_000, -0.152);
      expect(html).toContain("text-destructive");
      expect(html).toContain("-0.15%");
    });

    it("billions still format through Intl without exponent", () => {
      const money = 1_234_567_890_123;
      const html = render(money, 12_345_678, 1.01);
      assertHeadlineDelta(html, money, 12_345_678, 1.01);
    });

    it("Number.MAX_SAFE_INTEGER equity is formatted, not exponentiated", () => {
      const money = Number.MAX_SAFE_INTEGER;
      const html = render(money, 0, 0);
      expect(html).toContain(gbpWhole.format(money));
      assertNoBadTokens(html);
    });

    it("large negative equity renders with locale minus and grouping", () => {
      const html = render(-987_654_321, -1_000_000, -0.101);
      assertHeadlineDelta(html, -987_654_321, -1_000_000, -0.101);
      expect(html).toContain("text-destructive");
    });
  });

  describe("very small totals", () => {
    it("sub-penny positive equity rounds to £0 headline, keeps sign on pct", () => {
      const html = render(0.004, 0.004, 0.001);
      expect(html).toContain(gbpWhole.format(0.004)); // "£0"
      expect(html).toContain("+0.00%");
      expect(html).toContain(`+${numWhole.format(0.004)}`); // "+0"
      assertNoBadTokens(html);
    });

    it("sub-penny negative equity rounds to £0 headline via formatter", () => {
      const html = render(-0.004, -0.004, -0.001);
      expect(html).toContain(gbpWhole.format(-0.004)); // "-£0" or "£0" per locale
      expect(html).toContain("-0.00%");
      expect(html).toContain(numWhole.format(-0.004));
      expect(html).toContain("text-destructive");
      assertNoBadTokens(html);
    });

    it("micro-fraction PnL (1e-6) does not leak scientific notation", () => {
      const html = render(300, 1e-6, 3.33e-7);
      // Percent rounds via toFixed(2) → "+0.00%"; delta rounds to 0.
      expect(html).toContain("+0.00%");
      expect(html).toContain(`+${numWhole.format(1e-6)}`);
      assertNoBadTokens(html);
    });

    it("Number.EPSILON PnL renders cleanly (no exponent, no NaN)", () => {
      const html = render(300, Number.EPSILON, Number.EPSILON);
      expect(html).toContain("+0.00%");
      assertNoBadTokens(html);
    });
  });

  describe("values near zero", () => {
    it("exact zero everywhere renders £0 / +0.00% / +0", () => {
      const html = render(0, 0, 0);
      expect(html).toContain(gbpWhole.format(0));
      expect(html).toContain("+0.00%");
      expect(html).toContain(`+${numWhole.format(0)}`);
      // Zero pnl takes the >=0 branch → emerald tone.
      expect(html).toContain("text-success");
      assertNoBadTokens(html);
    });

    it("negative zero (-0) behaves like +0 (pnl>=0 branch)", () => {
      const html = render(-0, -0, -0);
      // -0 formats identically to 0 through Intl.
      expect(html).toContain(gbpWhole.format(0));
      // -0 >= 0 is true → "+" prefix, emerald tone.
      expect(html).toContain("+0.00%");
      expect(html).toContain("text-success");
      assertNoBadTokens(html);
    });

    it("+epsilon PnL takes the positive branch", () => {
      const html = render(300, 1e-9, 1e-9);
      expect(html).toContain("+0.00%");
      expect(html).toContain("text-success");
      assertNoBadTokens(html);
    });

    it("-epsilon PnL takes the negative branch (no '+' prefix)", () => {
      const html = render(300, -1e-9, -1e-9);
      expect(html).toContain("-0.00%");
      expect(html).toContain("text-destructive");
      expect(html).not.toContain("+-0.00%");
      assertNoBadTokens(html);
    });

    it("crossing zero: tiny gain vs tiny loss produce mirror-image sub-values", () => {
      const gain = render(300, 0.0001, 0.00003);
      const loss = render(300, -0.0001, -0.00003);
      expect(gain).toContain("+0.00%");
      expect(loss).toContain("-0.00%");
      expect(gain).toContain("text-success");
      expect(loss).toContain("text-destructive");
    });
  });

  describe("stability across magnitudes", () => {
    it("scaling money by 1000 scales headline through the same formatter", () => {
      const base = 12.34;
      for (const k of [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000]) {
        const html = render(base * k, 0, 0);
        expect(html).toContain(gbpWhole.format(base * k));
        assertNoBadTokens(html);
      }
    });

    it("rendering the same extreme value twice is byte-identical", () => {
      const a = render(1_234_567_890, -12_345.6, -0.001);
      const b = render(1_234_567_890, -12_345.6, -0.001);
      expect(a).toBe(b);
    });
  });
});
