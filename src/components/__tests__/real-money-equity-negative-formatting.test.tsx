// Lock in rounding & formatting for the real-money equity tile when
// stored snapshot totals produce NEGATIVE equity or a NEGATIVE PnL
// delta. Runs the same pipeline the dashboard uses:
//   snapshots → buildAllPortfoliosEquity → todaySummary reducer →
//   <ModeSummaryTile />
// and asserts the rendered HTML uses the shared Intl formatters
// consistently (whole GBP headline, whole-number delta, 2dp percent,
// correct sign prefixes, negative-tone class).

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAllPortfoliosEquity,
  type EquitySnapshotInput,
  type PortfolioEquityInput,
} from "@/lib/all-portfolios-equity";
import { ModeSummaryTile } from "@/routes/index";

const LIVE = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-07-24";

// Must match ModeSummaryTile's Intl config exactly.
const gbpWhole = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const numWhole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function computeTodaySummary(
  data: ReturnType<typeof buildAllPortfoliosEquity>,
) {
  const { series, portfolios } = data;
  const hasModeValue = (row: Record<string, unknown>, real: boolean) =>
    portfolios.some((p) => {
      const isReal = p.mode === "live_prod";
      if (isReal !== real) return false;
      return Number.isFinite(Number(row[p.id]));
    });
  const sumMode = (row: Record<string, unknown>, real: boolean) =>
    portfolios.reduce((sum, p) => {
      const isReal = p.mode === "live_prod";
      if (isReal !== real) return sum;
      const v = Number(row[p.id]);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
  const modeSummary = (real: boolean) => {
    const rows = series.filter((r) =>
      hasModeValue(r as Record<string, unknown>, real),
    ) as Array<Record<string, unknown>>;
    const last = rows[rows.length - 1];
    if (!last) return { now: 0, pnl: 0, pct: 0 };
    const prev = rows.length > 1 ? rows[rows.length - 2] : last;
    const now = sumMode(last, real);
    const previous = sumMode(prev, real);
    return {
      now,
      pnl: now - previous,
      pct: previous > 0 ? ((now - previous) / previous) * 100 : 0,
    };
  };
  return {
    real: {
      ...modeSummary(true),
      count: portfolios.filter((p) => p.mode === "live_prod").length,
    },
  };
}

function renderReal(real: {
  now: number;
  pnl: number;
  pct: number;
  count: number;
}) {
  return renderToStaticMarkup(
    <ModeSummaryTile
      label="Real-money equity"
      sublabel="REAL · live Saxo"
      tone="real"
      money={real.now}
      pnl={real.pnl}
      pct={real.pct}
      count={real.count}
    />,
  );
}

function build(
  portfolios: PortfolioEquityInput[],
  snapshots: EquitySnapshotInput[],
) {
  const data = buildAllPortfoliosEquity({ portfolios, snapshots, today: TODAY });
  return { html: renderReal(computeTodaySummary(data).real), summary: computeTodaySummary(data).real };
}

const livePortfolio = (current_cash: number): PortfolioEquityInput => ({
  id: LIVE,
  name: "Live Saxo",
  currency: "GBP",
  mode: "live_prod",
  starting_cash: 300,
  current_cash,
});

describe("real-money equity tile — negative equity & negative PnL formatting", () => {
  it("negative equity headline uses the shared GBP formatter with a leading minus", () => {
    const { html, summary } = build(
      [livePortfolio(-125.4)],
      [
        { portfolio_id: LIVE, snapshot_date: "2026-07-23", total_value: -100 },
        { portfolio_id: LIVE, snapshot_date: TODAY, total_value: -125.4 },
      ],
    );
    expect(summary.now).toBe(-125.4);
    // Formatter output IS the source of truth (locale-dependent minus).
    expect(html).toContain(gbpWhole.format(-125.4));
    // Never emit the raw 2dp value for the headline.
    expect(html).not.toContain("-125.4");
    expect(html).not.toContain("125.40");
  });

  it("negative PnL delta uses the red-tone class and no '+' prefix", () => {
    const { html, summary } = build(
      [livePortfolio(280)],
      [
        { portfolio_id: LIVE, snapshot_date: "2026-07-23", total_value: 300 },
        { portfolio_id: LIVE, snapshot_date: TODAY, total_value: 280 },
      ],
    );
    expect(summary.pnl).toBeCloseTo(-20, 10);
    expect(summary.pct).toBeCloseTo(-6.6666, 3);
    expect(html).toContain("text-red-400");
    expect(html).not.toContain("text-emerald-400");
    // Percent to exactly 2dp, no double-sign.
    expect(html).toContain("-6.67%");
    expect(html).not.toContain("+-6.67%");
    // Delta formatted with the shared whole-number formatter.
    expect(html).toContain(`${numWhole.format(-20)}`);
    expect(html).not.toContain("+-20");
  });

  it("negative fractional PnL rounds via the shared formatter (no raw decimals)", () => {
    const { html } = build(
      [livePortfolio(299.54)],
      [
        { portfolio_id: LIVE, snapshot_date: "2026-07-23", total_value: 300 },
        { portfolio_id: LIVE, snapshot_date: TODAY, total_value: 299.54 },
      ],
    );
    // -0.46 rounds via maximumFractionDigits: 0.
    expect(html).toContain(numWhole.format(-0.46));
    expect(html).not.toMatch(/-0\.46/);
    // Percent stays at exactly 2dp.
    expect(html).toContain("-0.15%");
  });

  it("negative-to-negative delta (deepening loss) keeps a single minus on both figures", () => {
    const { html, summary } = build(
      [livePortfolio(-40)],
      [
        { portfolio_id: LIVE, snapshot_date: "2026-07-23", total_value: -10 },
        { portfolio_id: LIVE, snapshot_date: TODAY, total_value: -40 },
      ],
    );
    // Headline is negative; percent uses prev>0 guard → 0 when prev<=0.
    expect(html).toContain(gbpWhole.format(-40));
    expect(summary.pct).toBe(0); // guarded because previous <= 0
    expect(html).toContain("-0.00%"); // -30 pnl → red branch, -0.00
    expect(html).toContain("text-red-400");
    expect(html).toContain(numWhole.format(-30));
  });

  it("large negative equity is grouped by the locale formatter", () => {
    const stored = -12_345.67;
    const html = renderReal({ now: stored, pnl: -500.9, pct: -3.9, count: 1 });
    expect(html).toContain(gbpWhole.format(stored)); // e.g. "-£12,346"
    expect(html).toContain(numWhole.format(-500.9)); // e.g. "-501"
    expect(html).toContain("-3.90%");
    // Raw ungrouped digits must not appear as the headline.
    expect(html).not.toContain(">12345<");
    expect(html).not.toContain(">-12345<");
  });

  it("negative percent keeps trailing zeros to reach exactly 2dp", () => {
    const html = renderReal({ now: 250, pnl: -50, pct: -5, count: 1 });
    expect(html).toContain("-5.00%");
    expect(html).not.toMatch(/-5%/);
    expect(html).not.toMatch(/-5\.0%/);
  });

  it("tiny negative percent rounds via toFixed(2), never truncates the sign", () => {
    const html = renderReal({ now: 299.99, pnl: -0.01, pct: -0.003, count: 1 });
    expect(html).toContain("-0.00%");
    expect(html).not.toMatch(/\+-?0/);
    expect(html).toContain("text-red-400");
  });

  it("headline & delta share the same locale for negative figures — no mixed grouping", () => {
    const html = renderReal({ now: -9_876, pnl: -9_876, pct: -50, count: 1 });
    const moneyStr = gbpWhole.format(-9_876);
    const deltaStr = numWhole.format(-9_876);
    expect(html).toContain(moneyStr);
    expect(html).toContain(deltaStr);
    // Digit portion of the money string equals the delta string.
    const moneyDigits = moneyStr.replace(/[^\d,\s.\-−]/g, "").trim();
    expect(moneyDigits).toBe(deltaStr);
  });

  it("negative rendering is idempotent for the same stored snapshot", () => {
    const a = renderReal({ now: -125.4, pnl: -20, pct: -13.79, count: 1 });
    const b = renderReal({ now: -125.4, pnl: -20, pct: -13.79, count: 1 });
    expect(a).toBe(b);
  });
});
