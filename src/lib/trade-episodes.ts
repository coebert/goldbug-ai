// Trade-duration ("holding period") annotations for time-series charts.
//
// Buy/sell markers answer *when* something was executed. They do not answer
// how long a position was actually held, which is the question you ask when a
// drawdown starts: "what were we in at the time, and when did we get out?"
//
// This module folds a flat list of executed trades into position EPISODES —
// one span per symbol from the fill that opened it to the fill that flattened
// it — and snaps those spans onto the x-values a chart plots, so a band always
// starts and ends on a rendered point instead of floating between two.
//
// Pure and client-safe: no recharts, no DOM. Rendering lives in
// `src/components/charts/trade-episode-bands.tsx`.

import type { MarkerTrade } from "./chart-trade-markers";
import { tradeTimestamp } from "./chart-trade-markers";

export type PositionEpisode = {
  symbol: string;
  /** Direction of the position, taken from the fill that opened it. */
  side: "long" | "short";
  /** Timestamp of the opening fill (ms). */
  openMs: number;
  /** Timestamp of the flattening fill (ms), or null while still open. */
  closeMs: number | null;
  /** ISO/date string of the opening fill, as supplied by the trade. */
  openAt: string;
  closeAt: string | null;
  /** Peak absolute quantity held during the episode. */
  peakQuantity: number;
  /** Quantity-weighted average buy and sell price. */
  avgBuy: number;
  avgSell: number | null;
  buys: number;
  sells: number;
  /** Realised P&L on the closed quantity, in trade currency; null while open. */
  realized: number | null;
  /** Calendar days held (fractional), from open fill to close fill or `now`. */
  days: number;
  open: boolean;
};

const QTY_EPS = 1e-6;

function n(v: number | string | null | undefined): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function isoOf(t: MarkerTrade): string {
  return String(t.executed_at ?? t.trade_date ?? "");
}

/**
 * Fold executed trades into per-symbol position episodes.
 *
 * Signed running quantity: a buy from flat opens an episode, and the episode
 * closes on the fill that returns the position to (approximately) zero. A
 * position that reverses through zero in a single fill closes the old episode
 * and opens a new one at the same timestamp, so a long→short flip reads as two
 * spans rather than one impossible one.
 *
 * `asOfMs` dates the still-open episodes (defaults to now) so their duration
 * is measured, not left blank.
 */
export function buildPositionEpisodes(
  trades: readonly MarkerTrade[],
  asOfMs: number = Date.now(),
): PositionEpisode[] {
  type Live = {
    openMs: number;
    openAt: string;
    side: "long" | "short";
    qty: number;
    peak: number;
    buys: number;
    sells: number;
    buyQty: number;
    buyCost: number;
    sellQty: number;
    sellProceeds: number;
  };

  const bySymbol = new Map<string, MarkerTrade[]>();
  for (const t of trades) {
    if (!t || !t.symbol) continue;
    const ts = tradeTimestamp(t);
    if (!Number.isFinite(ts)) continue;
    const key = String(t.symbol).toUpperCase();
    const list = bySymbol.get(key);
    if (list) list.push(t);
    else bySymbol.set(key, [t]);
  }

  const out: PositionEpisode[] = [];

  for (const [symbol, list] of bySymbol) {
    const sorted = [...list].sort((a, b) => tradeTimestamp(a) - tradeTimestamp(b));
    let live: Live | null = null;

    const start = (t: MarkerTrade): Live => ({
      openMs: tradeTimestamp(t),
      openAt: isoOf(t),
      side: t.side === "sell" ? "short" : "long",
      qty: 0,
      peak: 0,
      buys: 0,
      sells: 0,
      buyQty: 0,
      buyCost: 0,
      sellQty: 0,
      sellProceeds: 0,
    });

    const finish = (l: Live, closeMs: number | null, closeAt: string | null) => {
      const avgBuy = l.buyQty > QTY_EPS ? l.buyCost / l.buyQty : 0;
      const matched = Math.min(l.buyQty, l.sellQty);
      const avgSell = l.sellQty > QTY_EPS ? l.sellProceeds / l.sellQty : null;
      const realized =
        closeMs != null && avgSell != null && matched > QTY_EPS
          ? Number(((avgSell - avgBuy) * matched).toFixed(4))
          : null;
      const endMs = closeMs ?? asOfMs;
      out.push({
        symbol,
        side: l.side,
        openMs: l.openMs,
        closeMs,
        openAt: l.openAt,
        closeAt,
        peakQuantity: Number(l.peak.toFixed(6)),
        avgBuy: Number(avgBuy.toFixed(6)),
        avgSell: avgSell == null ? null : Number(avgSell.toFixed(6)),
        buys: l.buys,
        sells: l.sells,
        realized,
        days: Math.max(0, Number(((endMs - l.openMs) / 86_400_000).toFixed(3))),
        open: closeMs == null,
      });
    };


    for (const t of sorted) {
      const ts = tradeTimestamp(t);
      const qty = Math.abs(n(t.quantity));
      const price = Math.abs(n(t.price));
      if (qty <= QTY_EPS) continue;
      const signed = t.side === "sell" ? -qty : qty;

      // A sell with nothing open is a stray fill (data gap, or a position
      // opened before the window). Treat it as an episode of its own so the
      // exit is still annotated rather than silently dropped.
      if (!live) live = start(t);

      const before = live.qty;
      const after = before + signed;

      if (t.side === "sell") {
        live.sells += 1;
        live.sellQty += qty;
        live.sellProceeds += qty * price;
      } else {
        live.buys += 1;
        live.buyQty += qty;
        live.buyCost += qty * price;
      }
      live.qty = after;
      live.peak = Math.max(live.peak, Math.abs(after), Math.abs(before));

      const flat = Math.abs(after) <= QTY_EPS;
      const flipped = before > QTY_EPS && after < -QTY_EPS;
      if (flat || flipped) {
        finish(live, ts, isoOf(t));
        live = null;
        if (flipped) {
          // Re-open on the residual of the reversing fill.
          live = start(t);
          live.qty = after;
          live.peak = Math.abs(after);
          live.sells = 1;
          live.sellQty = Math.abs(after);
          live.sellProceeds = Math.abs(after) * price;
        }
      }
    }

    if (live) finish(live, null, null);
  }

  return out.sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
}

export type EpisodeBand = {
  key: string;
  symbol: string;
  /** x-values on the plotted series, safe to hand to a recharts ReferenceArea. */
  x1: string;
  x2: string;
  episode: PositionEpisode;
  /** True when the band was clipped to the start/end of the visible window. */
  clippedLeft: boolean;
  clippedRight: boolean;
};

const MS = (v: string): number => {
  const s = String(v);
  const iso = s.length <= 10 ? `${s}T00:00:00Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NaN;
};

/**
 * Snap episodes onto the chart's x-values.
 *
 * The open edge snaps forward to the first plotted point at/after the fill and
 * the close edge snaps back to the last point at/before it, so a band never
 * extends past data that exists. Episodes entirely outside the window are
 * dropped; episodes overlapping it are clipped and flagged.
 */
export function episodeBands(
  episodes: readonly PositionEpisode[],
  xValues: readonly string[],
): EpisodeBand[] {
  if (xValues.length === 0) return [];
  const xs = xValues.map(String);
  const stamps = xs.map(MS);
  const firstMs = stamps[0]!;
  const lastMs = stamps[stamps.length - 1]!;
  const bands: EpisodeBand[] = [];

  for (const ep of episodes) {
    const openMs = ep.openMs;
    const closeMs = ep.closeMs ?? lastMs;
    if (!Number.isFinite(openMs)) continue;
    if (closeMs < firstMs || openMs > lastMs) continue;

    let i1 = 0;
    for (let i = 0; i < stamps.length; i++) {
      if (Number.isFinite(stamps[i]!) && stamps[i]! >= openMs) {
        i1 = i;
        break;
      }
      i1 = stamps.length - 1;
    }
    let i2 = i1;
    for (let i = stamps.length - 1; i >= 0; i--) {
      if (Number.isFinite(stamps[i]!) && stamps[i]! <= closeMs) {
        i2 = i;
        break;
      }
    }
    if (i2 < i1) i2 = i1;

    bands.push({
      key: `${ep.symbol}:${ep.openAt}:${ep.closeAt ?? "open"}`,
      symbol: ep.symbol,
      x1: xs[i1]!,
      x2: xs[i2]!,
      episode: ep,
      clippedLeft: openMs < firstMs,
      clippedRight: (ep.closeMs ?? Number.POSITIVE_INFINITY) > lastMs,
    });
  }

  return bands;
}

/** Bands overlapping a given x-value — what the tooltip should describe. */
export function bandsAt(bands: readonly EpisodeBand[], x: string): EpisodeBand[] {
  const t = MS(x);
  if (!Number.isFinite(t)) return [];
  return bands.filter((b) => {
    const a = MS(b.x1);
    const z = MS(b.x2);
    return Number.isFinite(a) && Number.isFinite(z) && t >= a && t <= z;
  });
}

function shortDate(v: string | null): string {
  if (!v) return "open";
  const t = MS(v);
  if (!Number.isFinite(t)) return String(v).slice(0, 10);
  return new Date(t).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Europe/London",
  });
}

/** Human duration: hours under a day, otherwise days. */
export function formatHoldingDuration(days: number): string {
  if (!Number.isFinite(days) || days < 0) return "—";
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours}h`;
  }
  const d = Math.round(days);
  return `${d}d`;
}

/** One tooltip line per holding period covering a point. */
export function describeEpisodes(
  bands: readonly EpisodeBand[],
  money: (v: number) => string,
  maxLines = 4,
): string[] {
  if (bands.length === 0) return [];
  const shown = bands.slice(0, maxLines);
  const lines = shown.map((b) => {
    const ep = b.episode;
    const span = `${shortDate(ep.openAt)} → ${ep.open ? "open" : shortDate(ep.closeAt)}`;
    const pnl =
      ep.realized == null
        ? ""
        : ` · ${ep.realized >= 0 ? "+" : "−"}${money(Math.abs(ep.realized))}`;
    return `▮ ${ep.symbol} held ${formatHoldingDuration(ep.days)} (${span})${pnl}`;
  });
  const extra = bands.length - shown.length;
  if (extra > 0) lines.push(`+${extra} more holding${extra === 1 ? "" : "s"}`);
  return lines;
}

/**
 * Build a band directly from an already-computed span (backtest arms track
 * holding periods themselves, in trading days, and never see fills).
 */
export function spanBand(input: {
  symbol: string;
  x1: string;
  x2: string;
  days: number;
  open?: boolean;
  realized?: number | null;
}): EpisodeBand {
  const open = input.open ?? false;
  const episode: PositionEpisode = {
    symbol: input.symbol,
    side: "long",
    openMs: MS(input.x1),
    closeMs: open ? null : MS(input.x2),
    openAt: input.x1,
    closeAt: open ? null : input.x2,
    peakQuantity: 0,
    avgBuy: 0,
    avgSell: null,
    buys: 1,
    sells: open ? 0 : 1,
    realized: input.realized ?? null,
    days: input.days,
    open,
  };
  return {
    key: `${input.symbol}:${input.x1}:${open ? "open" : input.x2}`,
    symbol: input.symbol,
    x1: input.x1,
    x2: input.x2,
    episode,
    clippedLeft: false,
    clippedRight: open,
  };
}
