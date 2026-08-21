// Portfolio-level cost governor.
//
// Why this exists (evidence, live_prod "My Portfolio", 25 Jul – 10 Aug 2026):
//
//   40 fills, £14.1k of buys + £7.2k of sells on a ~£10.2k account. That is
//   ~2x account turnover in eleven trading days. Average ticket sizes were
//   £70–£500, against a Saxo LSE commission FLOOR of £3 per side plus 0.5%
//   UK stamp duty on non-exempt shares. Reconstructed friction for that
//   window is ~£180–200 — about 1.8% of NAV — while realised equity fell
//   ~£100. In other words the strategy was roughly break-even *gross* and
//   the losses were manufactured almost entirely by trading costs.
//
// `trade-viability-gate` already blocks an individual uneconomic ticket, but
// it is memoryless: fifty individually "viable" £400 tickets still burn 2% of
// a small account in a fortnight. This module adds the missing portfolio-level
// memory — three budgets that a single trade cannot see:
//
//   1. NAV-scaled minimum ticket   — a £10k account has no business placing
//      £70 orders; the fixed commission floor makes them structurally
//      negative-EV no matter how good the signal.
//   2. Rolling cost budget         — total estimated friction over a trailing
//      window is capped as a % of NAV. Once spent, new BUYs wait for the
//      window to roll. Exits are never blocked.
//   3. Churn controls              — a per-day BUY ticket cap and a per-symbol
//      re-entry/add cooldown, which together stop one position being nibbled
//      into existence across nine separate commissionable orders (MKS.L, 9
//      buys, £495 average ticket).
//
// Pure and I/O-free: the caller resolves NAV, the trailing cost total and the
// per-symbol last-buy ages, and passes base-currency notionals.

import { engineSymbolKey } from "./price-symbol";
import {
  edgesComparable,
  stampPreferenceSurcharge,
  type StampExemptPreference,
} from "./sizing/stamp-exempt-preference";

export type GovernorCandidate = {
  symbol: string;
  side: "buy" | "sell";
  /** Ticket notional converted into the portfolio's base currency. */
  notionalBase: number;
  /** Estimated round-trip friction for this ticket, in base currency. */
  estCostBase: number;
  /** True when the portfolio already holds this symbol (i.e. this is an add). */
  isAdd?: boolean;
  /**
   * Conviction in [0,1] (typically |unifiedScore|). Drives admission ranking:
   * a tight cost budget should be spent on the best ideas, not the biggest
   * tickets. Absent = treated as neutral (0.5).
   */
  edgeScore?: number;
  /**
   * Expected favourable move for this idea, as a fraction of notional
   * (0.04 = 4%). Absent = a conservative 2% is assumed.
   */
  expectedMovePct?: number;
  /**
   * True when a BUY of this instrument attracts 0.5% UK stamp duty (UK single
   * stocks). ETFs/ETCs and non-UK listings are exempt and therefore have a
   * lower break-even, which the ranking can be told to prefer.
   */
  stampLiable?: boolean;
};


export type GovernorConfig = {
  /** Portfolio NAV in base currency. */
  navBase: number;
  /** Minimum ticket as a fraction of NAV (0.03 = 3%). */
  minTicketPctOfNav: number;
  /** Absolute minimum ticket in base currency, whichever is larger. */
  absoluteMinTicketBase: number;
  /** Maximum number of BUY tickets admitted per day. */
  maxBuysPerDay: number;
  /** BUY tickets already routed today. */
  buysAlreadyToday: number;
  /** Rolling friction budget as a fraction of NAV over the trailing window. */
  costBudgetPctOfNav: number;
  /** Estimated friction already spent over the trailing window, base ccy. */
  trailingCostBase: number;
  /** Days a symbol must rest before another BUY in the same name. */
  addCooldownDays: number;
  /** Days since the last BUY per symbol; absent = never bought. */
  lastBuyDaysAgo: Record<string, number | undefined>;
  /**
   * Current gross exposure per symbol (base currency), keyed the same way as
   * candidate symbols. Used for the single-name concentration cap.
   */
  positionExposureBase?: Record<string, number | undefined>;
  /**
   * Hard cap on any single name as a fraction of NAV. A £10k book that
   * nibbles one ticker across nine tickets ends up 31% in that name with no
   * decision ever having approved it. Default 0.15.
   */
  maxPositionPctOfNav?: number;
  /**
   * Prefer stamp-exempt instruments (ETFs/ETCs, non-UK listings) over UK
   * single stocks when signal strength is comparable. "off" ranks on the cost
   * model alone; "balanced"/"strong" re-count part of the 50bps stamp charge
   * when ranking, and break near-ties in favour of the exempt instrument.
   */
  stampExemptPreference?: StampExemptPreference;
  /**
   * Escape valve for the rolling friction budget. A burst of churn (or a
   * forced de-risking sequence, whose SELL costs also land in the trailing
   * total) can exhaust the window's budget and then block EVERY buy for the
   * rest of the window — an unintended full stop that left a live account
   * idle for eleven trading days with cash on hand. At most this many
   * exceptional tickets per tick may draw on the reserve, and only when the
   * idea's expected gross edge clears its own friction by
   * `RESERVE_EDGE_MULTIPLE` and conviction is at least
   * `RESERVE_MIN_CONVICTION`. Set to 0 to restore a hard budget.
   */
  highEdgeReserveTickets?: number;
  /**
   * Days since the last BUY actually filled anywhere in the book (any symbol).
   * A small account whose 40bps window is spent by one rebalance day cannot
   * buy again for weeks — observed live: fourteen calendar days with cash on
   * hand and every candidate skipped with "trailing cost budget exhausted".
   * Once this crosses `STALL_DAYS` the reserve relaxes to a lower bar so the
   * budget degrades into a throttle rather than a stop.
   */
  daysSinceLastBuyFill?: number;
};

/** Exceptional tickets allowed past an exhausted budget per tick. */
export const DEFAULT_HIGH_EDGE_RESERVE_TICKETS = 1;
/** Expected gross edge must be this multiple of the ticket's friction. */
export const RESERVE_EDGE_MULTIPLE = 5;
/** …and the idea must be a genuinely strong one. */
export const RESERVE_MIN_CONVICTION = 0.6;
/** No BUY fill for this many days ⇒ the reserve bar drops (stall breaker). */
export const STALL_DAYS = 5;
/** Relaxed reserve bar once the book has stalled. */
export const STALL_RESERVE_EDGE_MULTIPLE = 2;
export const STALL_RESERVE_MIN_CONVICTION = 0.5;
/**
 * The window budget can never be smaller than this many typical tickets'
 * friction. On a £10k book 40bps is ~£40 — less than four UK tickets — so a
 * single de-risking sequence exhausts a whole month of buying.
 */
export const MIN_BUDGET_TICKETS = 3;






export type GovernorDecision =
  | { kind: "admit"; candidate: GovernorCandidate }
  | { kind: "skip"; candidate: GovernorCandidate; reason: string };

export type GovernorPlan = {
  decisions: GovernorDecision[];
  /** Remaining friction budget after admissions, base currency. */
  costBudgetRemainingBase: number;
  /** Effective minimum ticket applied, base currency. */
  minTicketBase: number;
};

/**
 * Hard ceiling on any single name, as a fraction of NAV. Evidence: MKS.L was
 * nibbled to 31% of a £10k book across nine tickets, so the account's fate
 * hung on one mid-cap retailer that no sizing decision ever sanctioned.
 */
export const DEFAULT_MAX_POSITION_PCT_OF_NAV = 0.15;

/** Sensible defaults for a small (< £50k) single-account portfolio. */

export const DEFAULT_GOVERNOR: Omit<
  GovernorConfig,
  "navBase" | "buysAlreadyToday" | "trailingCostBase" | "lastBuyDaysAgo"
> = {
  minTicketPctOfNav: 0.03,
  absoluteMinTicketBase: 250,
  maxBuysPerDay: 3,
  costBudgetPctOfNav: 0.004, // 40bps of NAV per trailing window (~4.8%/yr max drag)
  addCooldownDays: 5,
};

/**
 * The NAV-scaled minimum ticket. Small accounts are dominated by the fixed
 * commission floor, so the floor rises with NAV only until the percentage
 * rule takes over.
 */
export function minTicketBase(cfg: Pick<GovernorConfig, "navBase" | "minTicketPctOfNav" | "absoluteMinTicketBase">): number {
  const pct = Math.max(0, cfg.navBase) * Math.max(0, cfg.minTicketPctOfNav);
  return Math.max(cfg.absoluteMinTicketBase, pct);
}

/**
 * Expected edge per pound of friction: (conviction x expected move x notional)
 * divided by the ticket's estimated cost. This is the only ranking that makes
 * sense when the budget is scarce — a £250 ticket on a 0.9-conviction idea
 * beats a £2,000 ticket on a 0.1-conviction one, even though the big ticket
 * has lower *proportional* friction.
 */
export function edgePerCost(
  c: GovernorCandidate,
  stampExemptPreference?: StampExemptPreference,
): number {
  const conviction = Number.isFinite(c.edgeScore)
    ? Math.min(1, Math.max(0, Number(c.edgeScore)))
    : 0.5;
  const move = Number.isFinite(c.expectedMovePct)
    ? Math.max(0, Number(c.expectedMovePct))
    : 0.02;
  const grossEdge = conviction * move * Math.max(0, c.notionalBase);
  // Ranking-only surcharge: a stamp-liable buy carries a higher break-even, so
  // when the preference is on it must clear a higher bar to outrank an
  // exempt idea of similar strength.
  const surcharge = stampPreferenceSurcharge({
    notionalBase: c.notionalBase,
    stampLiable: c.stampLiable,
    level: stampExemptPreference,
  });
  const cost = Math.max(0.01, c.estCostBase + surcharge);
  return grossEdge / cost;
}

/**
 * Plan admissions. SELLs are always admitted — risk reduction must never be
 * gated by a cost budget. BUYs are ranked by expected edge per pound of
 * friction (notional as tie-break) and admitted while every budget holds.
 */
export function planAdmissions(
  candidates: GovernorCandidate[],
  cfg: GovernorConfig,
): GovernorPlan {
  const minTicket = minTicketBase(cfg);
  // Typical ticket friction on this tick, used to floor the window budget so
  // a small account always has room for a few tickets a month.
  const buyCosts = candidates
    .filter((c) => c.side === "buy" && Number.isFinite(c.estCostBase) && c.estCostBase > 0)
    .map((c) => c.estCostBase)
    .sort((a, b) => a - b);
  const typicalTicketCost = buyCosts.length
    ? buyCosts[Math.floor(buyCosts.length / 2)]!
    : 0;
  const budgetTotal = Math.max(
    Math.max(0, cfg.navBase) * Math.max(0, cfg.costBudgetPctOfNav),
    MIN_BUDGET_TICKETS * typicalTicketCost,
  );
  let budgetLeft = Math.max(0, budgetTotal - Math.max(0, cfg.trailingCostBase));
  let buysAdmitted = 0;

  const stalled = (cfg.daysSinceLastBuyFill ?? 0) >= STALL_DAYS;
  const reserveEdgeMultiple = stalled ? STALL_RESERVE_EDGE_MULTIPLE : RESERVE_EDGE_MULTIPLE;
  const reserveMinConviction = stalled ? STALL_RESERVE_MIN_CONVICTION : RESERVE_MIN_CONVICTION;
  let reserveLeft = Math.max(
    0,
    (cfg.highEdgeReserveTickets ?? DEFAULT_HIGH_EDGE_RESERVE_TICKETS) + (stalled ? 1 : 0),
  );


  const roomToday = Math.max(0, cfg.maxBuysPerDay - Math.max(0, cfg.buysAlreadyToday));

  const stampPref = cfg.stampExemptPreference ?? "off";
  const decisions: GovernorDecision[] = [];
  const sells = candidates.filter((c) => c.side === "sell");
  const buys = candidates
    .filter((c) => c.side === "buy")
    .slice()
    .sort((a, b) => {
      const ea = edgePerCost(a, stampPref);
      const eb = edgePerCost(b, stampPref);
      // Comparable signal strength → prefer the stamp-exempt instrument, which
      // needs ~50bps less to break even.
      if (
        stampPref !== "off" &&
        Boolean(a.stampLiable) !== Boolean(b.stampLiable) &&
        edgesComparable(ea, eb)
      ) {
        return a.stampLiable ? 1 : -1;
      }
      const diff = eb - ea;
      if (Math.abs(diff) > 1e-9) return diff;
      return b.notionalBase - a.notionalBase;
    });


  for (const c of sells) decisions.push({ kind: "admit", candidate: c });

  // Single-name concentration. Tracked as we admit so two tickets in the same
  // name inside one tick cannot jointly breach the cap.
  const maxPositionPct = Math.max(0, cfg.maxPositionPctOfNav ?? DEFAULT_MAX_POSITION_PCT_OF_NAV);
  const positionCap = Math.max(0, cfg.navBase) * maxPositionPct;
  const exposure = new Map<string, number>();
  for (const [k, v] of Object.entries(cfg.positionExposureBase ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) exposure.set(k.toUpperCase(), n);
  }

  for (const c of buys) {
    const symKey = engineSymbolKey(c.symbol);
    const cooldown = cfg.lastBuyDaysAgo[symKey] ?? cfg.lastBuyDaysAgo[c.symbol];

    if (cooldown !== undefined && cooldown < cfg.addCooldownDays) {
      decisions.push({
        kind: "skip",
        candidate: c,
        reason:
          `churn guard: ${c.symbol} was bought ${cooldown}d ago; ` +
          `same-name re-entry rests for ${cfg.addCooldownDays}d`,
      });
      continue;
    }

    const held = exposure.get(symKey) ?? 0;
    if (positionCap > 0 && held + c.notionalBase > positionCap) {
      decisions.push({
        kind: "skip",
        candidate: c,
        reason:
          `single-name cap: ${c.symbol} would reach ` +
          `${(((held + c.notionalBase) / Math.max(1, cfg.navBase)) * 100).toFixed(1)}% of NAV, ` +
          `above the ${(maxPositionPct * 100).toFixed(0)}% limit`,
      });
      continue;
    }


    if (c.notionalBase < minTicket) {
      decisions.push({
        kind: "skip",
        candidate: c,
        reason:
          `sub-scale ticket: ${c.notionalBase.toFixed(0)} below the ` +
          `${minTicket.toFixed(0)} minimum (max of ${(cfg.minTicketPctOfNav * 100).toFixed(1)}% of ` +
          `NAV ${cfg.navBase.toFixed(0)} and ${cfg.absoluteMinTicketBase})`,
      });
      continue;
    }

    if (buysAdmitted >= roomToday) {
      decisions.push({
        kind: "skip",
        candidate: c,
        reason: `daily buy-ticket cap reached (${cfg.maxBuysPerDay}/day, ${cfg.buysAlreadyToday} already routed)`,
      });
      continue;
    }

    if (c.estCostBase > budgetLeft) {
      // Reserve: an exceptional idea may still go, so an exhausted window can
      // never mean "no trading at all" while the signal is strong.
      const conviction = Number.isFinite(c.edgeScore) ? Number(c.edgeScore) : 0;
      const move = Number.isFinite(c.expectedMovePct) ? Number(c.expectedMovePct) : 0.02;
      const grossEdge = conviction * move * Math.max(0, c.notionalBase);
      const clears = grossEdge >= reserveEdgeMultiple * Math.max(0.01, c.estCostBase);
      if (reserveLeft > 0 && conviction >= reserveMinConviction && clears) {
        reserveLeft -= 1;
        buysAdmitted += 1;
        exposure.set(symKey, held + c.notionalBase);
        decisions.push({ kind: "admit", candidate: c });
        continue;
      }
      decisions.push({
        kind: "skip",
        candidate: c,
        reason:
          `trailing cost budget exhausted: ${cfg.trailingCostBase.toFixed(2)} of ` +
          `${budgetTotal.toFixed(2)} (${(cfg.costBudgetPctOfNav * 100).toFixed(2)}% of NAV) spent; ` +
          `this ticket needs ${c.estCostBase.toFixed(2)}` +
          (stalled ? ` [stalled ${Math.round(cfg.daysSinceLastBuyFill ?? 0)}d: relaxed reserve bar]` : "") +
          (reserveLeft > 0
            ? ` (high-edge reserve needs conviction ≥ ${reserveMinConviction} and ` +
              `${reserveEdgeMultiple}x edge cover; this idea has ${grossEdge.toFixed(2)})`
            : ""),

      });
      continue;
    }


    budgetLeft -= c.estCostBase;
    buysAdmitted += 1;
    exposure.set(symKey, held + c.notionalBase);
    decisions.push({ kind: "admit", candidate: c });

  }

  return {
    decisions,
    costBudgetRemainingBase: budgetLeft,
    minTicketBase: minTicket,
  };
}

/** Anchor points for the NAV-scaled governor profile. */
const NAV_ANCHORS: Array<{
  nav: number;
  minTicketPctOfNav: number;
  absoluteMinTicketBase: number;
  maxBuysPerDay: number;
  addCooldownDays: number;
}> = [
  { nav: 10_000, minTicketPctOfNav: 0.03, absoluteMinTicketBase: 250, maxBuysPerDay: 3, addCooldownDays: 5 },
  { nav: 50_000, minTicketPctOfNav: 0.02, absoluteMinTicketBase: 1_000, maxBuysPerDay: 5, addCooldownDays: 4 },
  { nav: 250_000, minTicketPctOfNav: 0.01, absoluteMinTicketBase: 2_000, maxBuysPerDay: 8, addCooldownDays: 3 },
];

/**
 * Scale the governor to account size. Larger accounts can carry more names and
 * more tickets before fixed costs matter, so the caps loosen with NAV while the
 * percentage-of-NAV budgets stay constant.
 *
 * Interpolated rather than banded: a step function meant £49,999 and £50,001
 * were governed very differently for no economic reason, and an account
 * drifting across a boundary would flip between profiles tick to tick.
 * Log-NAV interpolation matches how fixed costs actually decay with size.
 */
export function governorForNav(navBase: number): Omit<
  GovernorConfig,
  "navBase" | "buysAlreadyToday" | "trailingCostBase" | "lastBuyDaysAgo"
> {
  const nav = Math.max(1, Number(navBase) || 0);
  const lo = NAV_ANCHORS[0]!;
  const hi = NAV_ANCHORS[NAV_ANCHORS.length - 1]!;
  if (nav <= lo.nav) {
    return {
      ...DEFAULT_GOVERNOR,
      minTicketPctOfNav: lo.minTicketPctOfNav,
      absoluteMinTicketBase: lo.absoluteMinTicketBase,
      maxBuysPerDay: lo.maxBuysPerDay,
      addCooldownDays: lo.addCooldownDays,
    };
  }
  if (nav >= hi.nav) {
    return {
      ...DEFAULT_GOVERNOR,
      minTicketPctOfNav: hi.minTicketPctOfNav,
      absoluteMinTicketBase: hi.absoluteMinTicketBase,
      maxBuysPerDay: hi.maxBuysPerDay,
      addCooldownDays: hi.addCooldownDays,
    };
  }

  let a = lo;
  let b = hi;
  for (let i = 0; i < NAV_ANCHORS.length - 1; i += 1) {
    const left = NAV_ANCHORS[i]!;
    const right = NAV_ANCHORS[i + 1]!;
    if (nav >= left.nav && nav <= right.nav) {
      a = left;
      b = right;
      break;
    }
  }
  const t = (Math.log(nav) - Math.log(a.nav)) / (Math.log(b.nav) - Math.log(a.nav));
  const mix = (x: number, y: number) => x + (y - x) * t;

  return {
    ...DEFAULT_GOVERNOR,
    minTicketPctOfNav: mix(a.minTicketPctOfNav, b.minTicketPctOfNav),
    absoluteMinTicketBase: Math.round(mix(a.absoluteMinTicketBase, b.absoluteMinTicketBase)),
    maxBuysPerDay: Math.max(1, Math.round(mix(a.maxBuysPerDay, b.maxBuysPerDay))),
    addCooldownDays: Math.max(1, Math.round(mix(a.addCooldownDays, b.addCooldownDays))),
  };
}

