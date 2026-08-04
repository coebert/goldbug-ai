// Data-quality report: which positions the fills ledger cannot explain, and
// how the revaluer reconstructed their cost basis and the historical cash.
//
// A linked broker account can gain positions the app never executed — manual
// trades placed at Saxo, transfers in, or the first sync of an account that
// already held stock. Those positions have no rows in `live_fills`, so the
// ledger replay cannot derive either their cost basis or the cash they
// consumed. The revaluer papers over that with two documented fallbacks
// (`unbackedOpenings` + `cashOn`), and this module makes those fallbacks
// visible instead of implicit: for every position it says whether the number
// came from the trade ledger or from the broker's `avg_cost`, and for cash it
// spells out the anchor and every rollback leg.
//
// Pure module — no IO, no Supabase. The loader lives in
// `data-quality-report.server.ts`.

import { instrumentCurrency, positionKey, symbolKeys } from "./equity-snapshot-revalue";

export type DqHolding = {
  symbol: string;
  quantity: number | string | null;
  avg_cost?: number | string | null;
  instrument_ccy?: string | null;
  opened_at?: string | null;
};

export type DqFill = {
  symbol: string;
  side?: string | null;
  quantity: number | string | null;
  fill_price?: number | string | null;
  filled_at: string;
};

export type DqFundEvent = { at: string; amount: number | string | null };

export type DqSnapshot = {
  snapshot_date: string;
  cash?: number | string | null;
  total_value?: number | string | null;
};

/** Where a position's cost basis actually came from. */
export type CostBasisSource =
  /** Every share is backed by a buy fill — cost basis replays from the ledger. */
  | "fills_ledger"
  /** No buy fill at all — cost basis is the broker's reported average cost. */
  | "broker_avg_cost"
  /** Some shares are backed by fills, the remainder are broker-reported. */
  | "mixed"
  /** Neither source usable (no fills and no positive avg_cost). */
  | "unknown";

export type DqPosition = {
  /** Canonical comparison key shared by every spelling (e.g. "ISF"). */
  symbol: string;
  /** Raw symbol as stored on the holdings row (e.g. "ISF:xlon"). */
  holdingSymbol: string;
  quantity: number;
  /** Shares explained by buy fills in the ledger. */
  backedQuantity: number;
  /** Shares with no buy fill behind them. */
  unbackedQuantity: number;
  /** backedQuantity / quantity, 0–1. */
  coverage: number;
  buyFills: number;
  sellFills: number;
  firstFillAt: string | null;
  openedAt: string | null;
  ccy: string;
  fxRate: number;
  /** Broker-reported average cost, in the instrument's settlement currency. */
  avgCost: number;
  /** Total cost attributed to the unbacked shares, in the portfolio's base ccy. */
  unbackedCostBase: number;
  costBasisSource: CostBasisSource;
  severity: "ok" | "info" | "warn";
  explanation: string;
};

export type CashRollbackLeg = {
  kind: "buy_fill" | "sell_fill" | "fund_event" | "unbacked_opening";
  label: string;
  /** Signed adjustment applied to the anchor when rolling back to an earlier day. */
  amountBase: number;
  count: number;
};

export type CashReconstruction = {
  anchorSource: "latest_snapshot" | "portfolio_cash" | "none";
  anchorDate: string | null;
  anchorCash: number | null;
  legs: CashRollbackLeg[];
  /** True when every later fill has a usable price, so history can be rebuilt. */
  reconstructible: boolean;
  blockers: string[];
  explanation: string;
};

export type PortfolioDataQuality = {
  portfolioId: string;
  portfolioName: string;
  mode: string | null;
  baseCcy: string;
  positions: DqPosition[];
  summary: {
    positions: number;
    fullyBacked: number;
    partiallyBacked: number;
    unbacked: number;
    /** Cost of all unbacked shares, in base currency. */
    unbackedCostBase: number;
  };
  cash: CashReconstruction;
  severity: "ok" | "info" | "warn";
};

export type DataQualityReport = {
  generatedAt: string;
  portfolios: PortfolioDataQuality[];
  totals: {
    portfolios: number;
    positions: number;
    unbackedPositions: number;
    partiallyBackedPositions: number;
    portfoliosWithGaps: number;
  };
};

/** Share counts below this are broker dust, not a real coverage gap. */
export const DQ_QTY_TOLERANCE = 1e-6;

function num(v: unknown, fallback = 0): number {
  const n = Number(v ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function day(v: unknown): string {
  return String(v ?? "").slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number, ccy: string): string {
  return `${ccy} ${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
}

function rateFor(fx: Map<string, number>, ccy: string): number {
  const r = fx.get(ccy.toUpperCase());
  return Number.isFinite(r) && (r ?? 0) > 0 ? (r as number) : 1;
}

/** Net bought/sold per canonical symbol, with fill counts and first fill date. */
export function fillCoverage(fills: DqFill[]): Map<
  string,
  { bought: number; sold: number; buys: number; sells: number; firstAt: string | null }
> {
  const out = new Map<
    string,
    { bought: number; sold: number; buys: number; sells: number; firstAt: string | null }
  >();
  for (const f of fills) {
    const key = positionKey(String(f.symbol ?? ""));
    if (!key) continue;
    const qty = num(f.quantity);
    if (!(qty > 0)) continue;
    const entry =
      out.get(key) ?? { bought: 0, sold: 0, buys: 0, sells: 0, firstAt: null as string | null };
    const isSell = String(f.side ?? "buy").toLowerCase() === "sell";
    if (isSell) {
      entry.sold += qty;
      entry.sells += 1;
    } else {
      entry.bought += qty;
      entry.buys += 1;
    }
    const at = day(f.filled_at);
    if (at && (!entry.firstAt || at < entry.firstAt)) entry.firstAt = at;
    out.set(key, entry);
  }
  return out;
}

/**
 * Per-position coverage: how many of the held shares the ledger can account
 * for, and where the rest of the cost basis came from.
 */
export function analysePositions(
  holdings: DqHolding[],
  fills: DqFill[],
  baseCcy: string,
  fx: Map<string, number> = new Map(),
): DqPosition[] {
  const coverage = fillCoverage(fills);
  const base = baseCcy.toUpperCase();
  const out: DqPosition[] = [];

  for (const h of holdings) {
    const holdingSymbol = String(h.symbol ?? "");
    const key = positionKey(holdingSymbol);
    if (!key) continue;
    const quantity = num(h.quantity);
    if (!(quantity > DQ_QTY_TOLERANCE)) continue;

    const cov = coverage.get(key);
    // A buy fill only "backs" a share that is still held: sells consume the
    // backed shares first, so net (bought - sold) is the right numerator.
    const netBacked = cov ? cov.bought - cov.sold : 0;
    const backed = Math.max(0, Math.min(quantity, netBacked));
    const unbacked = Math.max(0, quantity - backed);
    const ccy = instrumentCurrency({ symbol: holdingSymbol, quantity, instrument_ccy: h.instrument_ccy ?? null });
    const rate = rateFor(fx, ccy);
    const avgCost = num(h.avg_cost);
    const unbackedCostBase = round2(unbacked * avgCost * rate);

    const hasGap = unbacked > DQ_QTY_TOLERANCE;
    const costBasisSource: CostBasisSource = !hasGap
      ? "fills_ledger"
      : avgCost > 0
        ? backed > DQ_QTY_TOLERANCE
          ? "mixed"
          : "broker_avg_cost"
        : "unknown";

    const fmtQty = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 4 });
    let explanation: string;
    if (costBasisSource === "fills_ledger") {
      explanation = `All ${fmtQty(quantity)} shares replay from ${cov?.buys ?? 0} buy fill${
        (cov?.buys ?? 0) === 1 ? "" : "s"
      } — cost basis and cash both come from the trade ledger.`;
    } else if (costBasisSource === "unknown") {
      explanation = `${fmtQty(unbacked)} share${unbacked === 1 ? "" : "s"} have no buy fill and no broker average cost, so neither cost basis nor the cash they consumed could be reconstructed. This position is excluded from historical cash rollback.`;
    } else {
      const legs: string[] = [];
      if (backed > DQ_QTY_TOLERANCE) {
        legs.push(`${fmtQty(backed)} share${backed === 1 ? "" : "s"} from the fills ledger`);
      }
      legs.push(
        `${fmtQty(unbacked)} share${unbacked === 1 ? "" : "s"} from the broker's average cost of ${money(avgCost, ccy)}`,
      );
      const fxNote = ccy === base ? "no FX conversion needed" : `converted at ${ccy}/${base} ${rate}`;
      explanation = `Cost basis is ${legs.join(" plus ")}. The unbacked shares are valued at ${money(
        unbacked * avgCost,
        ccy,
      )} (${fxNote}, ${money(unbackedCostBase, base)}), and that amount is credited back to every day before ${
        day(h.opened_at) || "the position appeared"
      } when rebuilding historical cash.`;
    }

    out.push({
      symbol: key,
      holdingSymbol,
      quantity,
      backedQuantity: round2(backed * 1e6) / 1e6,
      unbackedQuantity: round2(unbacked * 1e6) / 1e6,
      coverage: quantity > 0 ? Math.min(1, backed / quantity) : 0,
      buyFills: cov?.buys ?? 0,
      sellFills: cov?.sells ?? 0,
      firstFillAt: cov?.firstAt ?? null,
      openedAt: h.opened_at ? day(h.opened_at) : null,
      ccy,
      fxRate: rate,
      avgCost,
      unbackedCostBase,
      costBasisSource,
      severity: !hasGap ? "ok" : costBasisSource === "unknown" ? "warn" : "info",
      explanation,
    });
  }

  return out.sort(
    (a, b) => b.unbackedCostBase - a.unbackedCostBase || a.symbol.localeCompare(b.symbol),
  );
}

/**
 * Describe how historical cash is rebuilt for this portfolio: the anchor
 * balance and every leg rolled back through it, mirroring `cashOn`.
 */
export function describeCashReconstruction(params: {
  snapshots: DqSnapshot[];
  portfolioCash: number | null;
  fills: DqFill[];
  fundEvents: DqFundEvent[];
  positions: DqPosition[];
  baseCcy: string;
  fx?: Map<string, number>;
}): CashReconstruction {
  const { snapshots, portfolioCash, fills, fundEvents, positions } = params;
  const base = params.baseCcy.toUpperCase();
  const fx = params.fx ?? new Map<string, number>();

  const sorted = [...snapshots]
    .map((s) => ({ ...s, snapshot_date: day(s.snapshot_date) }))
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  const anchor = sorted.length > 0 ? sorted[sorted.length - 1]! : null;
  const anchorCash = anchor && Number.isFinite(num(anchor.cash, Number.NaN))
    ? num(anchor.cash)
    : Number.isFinite(num(portfolioCash, Number.NaN))
      ? num(portfolioCash)
      : null;
  const anchorSource: CashReconstruction["anchorSource"] =
    anchor && Number.isFinite(num(anchor.cash, Number.NaN))
      ? "latest_snapshot"
      : anchorCash != null
        ? "portfolio_cash"
        : "none";

  const blockers: string[] = [];
  let buyNotional = 0;
  let buys = 0;
  let sellNotional = 0;
  let sells = 0;

  for (const f of fills) {
    const qty = num(f.quantity);
    if (!(qty > 0)) continue;
    const px = num(f.fill_price, Number.NaN);
    const symbol = String(f.symbol ?? "");
    if (!Number.isFinite(px) || px <= 0) {
      blockers.push(`${symbol} fill on ${day(f.filled_at)} has no usable price`);
      continue;
    }
    const ccy = instrumentCurrency({ symbol, quantity: 0 });
    const notional = qty * px * rateFor(fx, ccy);
    if (String(f.side ?? "buy").toLowerCase() === "sell") {
      sellNotional += notional;
      sells += 1;
    } else {
      buyNotional += notional;
      buys += 1;
    }
  }

  let fundAmount = 0;
  let fundCount = 0;
  for (const e of fundEvents) {
    const amount = num(e.amount, Number.NaN);
    if (!Number.isFinite(amount)) {
      blockers.push(`funding event on ${day(e.at)} has no amount`);
      continue;
    }
    fundAmount += amount;
    fundCount += 1;
  }

  const unbacked = positions.filter((p) => p.unbackedCostBase > 0);
  const unbackedTotal = unbacked.reduce((a, p) => a + p.unbackedCostBase, 0);

  const legs: CashRollbackLeg[] = [];
  if (buys > 0) {
    legs.push({
      kind: "buy_fill",
      label: "Buy fills added back (cash we still held before the trade)",
      amountBase: round2(buyNotional),
      count: buys,
    });
  }
  if (sells > 0) {
    legs.push({
      kind: "sell_fill",
      label: "Sell proceeds removed (cash we did not have yet)",
      amountBase: round2(-sellNotional),
      count: sells,
    });
  }
  if (fundCount > 0) {
    legs.push({
      kind: "fund_event",
      label: "Deposits and withdrawals undone",
      amountBase: round2(-fundAmount),
      count: fundCount,
    });
  }
  if (unbacked.length > 0) {
    legs.push({
      kind: "unbacked_opening",
      label: "Broker-imported positions: cost credited back before they appeared",
      amountBase: round2(unbackedTotal),
      count: unbacked.length,
    });
  }

  const reconstructible = anchorCash != null && blockers.length === 0;
  const anchorPhrase =
    anchorSource === "latest_snapshot"
      ? `the most recent snapshot (${anchor?.snapshot_date}, ${money(anchorCash ?? 0, base)})`
      : anchorSource === "portfolio_cash"
        ? `the portfolio's current balance (${money(anchorCash ?? 0, base)})`
        : "no usable balance";

  const explanation =
    anchorSource === "none"
      ? "Historical cash cannot be rebuilt: there is no broker-synced balance to anchor the rollback to, so stored figures are kept as-is."
      : `Historical cash starts from ${anchorPhrase} — the balance a broker sync last refreshed — and is rolled backwards day by day: every later buy is added back, every later sale removed, every deposit or withdrawal undone${
          unbacked.length > 0
            ? `, and ${money(round2(unbackedTotal), base)} of broker-imported cost is credited back to the days before those ${unbacked.length} position${unbacked.length === 1 ? "" : "s"} appeared`
            : ""
        }.${
          blockers.length > 0
            ? ` ${blockers.length} ledger row${blockers.length === 1 ? "" : "s"} cannot be priced, so affected days keep their stored balance rather than an invented one.`
            : ""
        }`;

  return {
    anchorSource,
    anchorDate: anchor?.snapshot_date ?? null,
    anchorCash: anchorCash == null ? null : round2(anchorCash),
    legs,
    reconstructible,
    blockers: blockers.slice(0, 10),
    explanation,
  };
}

export function buildPortfolioDataQuality(params: {
  portfolioId: string;
  portfolioName: string;
  mode?: string | null;
  baseCcy?: string | null;
  holdings: DqHolding[];
  fills: DqFill[];
  fundEvents?: DqFundEvent[];
  snapshots?: DqSnapshot[];
  portfolioCash?: number | null;
  fx?: Map<string, number>;
}): PortfolioDataQuality {
  const baseCcy = String(params.baseCcy ?? "GBP").toUpperCase();
  const fx = params.fx ?? new Map<string, number>();
  const positions = analysePositions(params.holdings, params.fills, baseCcy, fx);

  const cash = describeCashReconstruction({
    snapshots: params.snapshots ?? [],
    portfolioCash: params.portfolioCash ?? null,
    fills: params.fills,
    fundEvents: params.fundEvents ?? [],
    positions,
    baseCcy,
    fx,
  });

  const fullyBacked = positions.filter((p) => p.costBasisSource === "fills_ledger").length;
  const partiallyBacked = positions.filter((p) => p.costBasisSource === "mixed").length;
  const unbacked = positions.filter(
    (p) => p.costBasisSource === "broker_avg_cost" || p.costBasisSource === "unknown",
  ).length;
  const unbackedCostBase = round2(positions.reduce((a, p) => a + p.unbackedCostBase, 0));

  const severity: PortfolioDataQuality["severity"] =
    positions.some((p) => p.severity === "warn") || !cash.reconstructible
      ? "warn"
      : partiallyBacked + unbacked > 0
        ? "info"
        : "ok";

  return {
    portfolioId: params.portfolioId,
    portfolioName: params.portfolioName,
    mode: params.mode ?? null,
    baseCcy,
    positions,
    summary: {
      positions: positions.length,
      fullyBacked,
      partiallyBacked,
      unbacked,
      unbackedCostBase,
    },
    cash,
    severity,
  };
}

export function summariseDataQuality(
  portfolios: PortfolioDataQuality[],
  generatedAt = new Date().toISOString(),
): DataQualityReport {
  return {
    generatedAt,
    portfolios: [...portfolios].sort((a, b) => {
      const rank = { warn: 0, info: 1, ok: 2 } as const;
      return rank[a.severity] - rank[b.severity] || a.portfolioName.localeCompare(b.portfolioName);
    }),
    totals: {
      portfolios: portfolios.length,
      positions: portfolios.reduce((a, p) => a + p.summary.positions, 0),
      unbackedPositions: portfolios.reduce((a, p) => a + p.summary.unbacked, 0),
      partiallyBackedPositions: portfolios.reduce((a, p) => a + p.summary.partiallyBacked, 0),
      portfoliosWithGaps: portfolios.filter((p) => p.severity !== "ok").length,
    },
  };
}

/** Exported for tests: every spelling a symbol may take. */
export { symbolKeys };
