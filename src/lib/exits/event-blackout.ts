/**
 * Event-blackout exit override.
 *
 * For positions whose notional > blackoutPctNav of portfolio value, force
 * a partial trim into a known high-impact event (earnings, FOMC, CPI) that
 * lands within `windowDays`. Trims down to `targetPctNav` so residual
 * exposure stays inside the risk budget without fully closing the thesis.
 */

export type BlackoutEvent = {
  event_date: string; // YYYY-MM-DD
  impact: string | null;
  kind: string | null;
  symbol?: string | null;
};

export type EventBlackoutInputs = {
  symbol: string;
  positionValue: number;
  portfolioValue: number;
  events: BlackoutEvent[];
  asOf: string; // YYYY-MM-DD
  windowDays: number;
  blackoutPctNav: number; // trigger threshold, e.g. 0.05
  targetPctNav: number;   // trim down to this, e.g. 0.03
  highImpactOnly: boolean;
};

export type EventBlackoutResult = {
  trim: boolean;
  sellFraction: number; // 0..1 of held quantity
  reason: string | null;
  matchedEvent: BlackoutEvent | null;
};

const HIGH_IMPACT = new Set(["high", "critical", "major"]);
const RELEVANT_KINDS = new Set(["earnings", "fomc", "cpi", "nfp", "guidance", "fed"]);

function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a + "T00:00:00Z");
  const tb = Date.parse(b + "T00:00:00Z");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Number.POSITIVE_INFINITY;
  return Math.round((ta - tb) / 86_400_000);
}

export function evaluateEventBlackout(i: EventBlackoutInputs): EventBlackoutResult {
  if (!(i.positionValue > 0) || !(i.portfolioValue > 0)) {
    return { trim: false, sellFraction: 0, reason: null, matchedEvent: null };
  }
  const posPct = i.positionValue / i.portfolioValue;
  if (posPct <= i.blackoutPctNav) {
    return { trim: false, sellFraction: 0, reason: null, matchedEvent: null };
  }
  const symLower = i.symbol.toLowerCase();
  const candidate = i.events.find((e) => {
    const dd = daysBetween(e.event_date, i.asOf);
    if (dd < 0 || dd > i.windowDays) return false;
    const kindMatches = e.kind && RELEVANT_KINDS.has(e.kind.toLowerCase());
    const symMatches = e.symbol && e.symbol.toLowerCase() === symLower;
    const macroWide = kindMatches && !e.symbol; // FOMC/CPI apply to everything
    if (i.highImpactOnly && !(e.impact && HIGH_IMPACT.has(e.impact.toLowerCase()))) return false;
    return Boolean(symMatches || macroWide);
  }) ?? null;
  if (!candidate) {
    return { trim: false, sellFraction: 0, reason: null, matchedEvent: null };
  }
  const targetPct = Math.max(0, Math.min(i.blackoutPctNav, i.targetPctNav));
  const sellFraction = Math.max(0, Math.min(1, 1 - targetPct / posPct));
  if (!(sellFraction > 0.01)) {
    return { trim: false, sellFraction: 0, reason: null, matchedEvent: candidate };
  }
  const dd = daysBetween(candidate.event_date, i.asOf);
  return {
    trim: true,
    sellFraction,
    reason: `event-blackout: ${candidate.kind ?? "event"}${candidate.symbol ? ` on ${candidate.symbol}` : ""} in ${dd}d, trim ${i.symbol} from ${(posPct * 100).toFixed(1)}% → ${(targetPct * 100).toFixed(1)}% NAV`,
    matchedEvent: candidate,
  };
}
