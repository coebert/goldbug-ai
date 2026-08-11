/**
 * Phase 4 — prove it.
 *
 * Two questions this module answers from the *realised* fill tape, not from
 * the cost model's own opinion of itself:
 *
 *   1. "Realised friction as a % of NAV, trailing 30d" — the single number
 *      that decides whether the live account makes money. Drawn against the
 *      governor's 40bps budget line so a breach is visible, not inferred.
 *
 *   2. "Did the Phase 1-3 changes actually help?" — a before/after split of
 *      the same tape at a cutover instant, comparing ticket count, average
 *      ticket, turnover and friction bps on each side.
 *
 * And one input to the harness: `realisedCostOverlay` turns the realised-vs-
 * modelled cost ratio into the multiplier shape `FrictionScenario` already
 * speaks, so the walk-forward / friction-ladder machinery can be re-run with
 * costs the broker actually charged instead of the ones we assumed.
 *
 * Everything here is pure: fills in, numbers out. The server module does the
 * reading and the FX.
 */

/**
 * One executed fill, already converted to the portfolio's base currency.
 *
 * `feeReportedBase` is what the broker booked (often zero — Saxo frequently
 * omits commission on the fill payload). `feeModelledBase` is what our cost
 * model says the ticket should have cost one-way. Charging the larger of the
 * two is the honest reading: a missing broker fee is missing data, not a free
 * trade, and a booked fee above the model means the model is optimistic.
 */
export type FrictionFill = {
  symbol: string;
  side: "buy" | "sell";
  /** Filled notional, base currency. */
  notionalBase: number;
  /** Commission/tax the broker actually booked, base currency. */
  feeReportedBase: number;
  /** Modelled one-way friction (commission + stamp + levy + half-spread). */
  feeModelledBase: number;
  /** Modelled commission leg alone, base currency. */
  commissionModelledBase: number;
  /** Modelled half-spread / impact leg, base currency. */
  spreadModelledBase: number;
  /** Modelled stamp duty + levies, base currency. */
  taxModelledBase: number;
  /**
   * The broker's own itemisation, when the cost report supplied one. Present
   * only for fills whose charges were ingested; when set it is what the
   * component split is drawn from, because the invoice beats the model's
   * guess at how the money was divided up.
   */
  reportedComponents?: FrictionComponents;
  /** Where the fee number came from. Drives the KPI's coverage figure. */
  feeSource?: "broker" | "model" | "none";
  /** ISO instant the fill printed. */
  filledAt: string;
};


/** Governor budget: 40bps of NAV per trailing 30 days. */
export const FRICTION_BUDGET_BPS = 40;
export const FRICTION_WINDOW_DAYS = 30;

export type FrictionComponents = {
  commissionBase: number;
  spreadBase: number;
  taxBase: number;
};

export type FrictionDailyPoint = {
  /** UTC day key, YYYY-MM-DD. */
  date: string;
  frictionBase: number;
  /** Cumulative friction from the window start, in bps of NAV. */
  cumulativeBps: number;
  tickets: number;
};

export type FrictionKpi = {
  windowDays: number;
  navBase: number;
  /** Total charged friction over the window, base currency. */
  frictionBase: number;
  /** Charged friction as bps of NAV. `null` when NAV is unknown. */
  frictionBps: number | null;
  budgetBps: number;
  /** Budget minus spend, bps. Negative means over budget. */
  headroomBps: number | null;
  breach: boolean;
  /** Fraction of the budget consumed (1 = exactly at the line). */
  budgetUsed: number | null;
  tickets: number;
  /** Buy + sell notional traded, base currency. */
  turnoverBase: number;
  /** Turnover as a multiple of NAV over the window. */
  turnoverRatio: number | null;
  avgTicketBase: number;
  components: FrictionComponents;
  /** Sum of broker-booked fees, base currency. */
  reportedBase: number;
  /** Sum of modelled one-way friction, base currency. */
  modelledBase: number;
  /**
   * Realised ÷ modelled. `null` when the broker booked nothing at all, which
   * is a data gap rather than evidence the model is wrong.
   */
  realisedRatio: number | null;
  /** Tickets whose costs came from the broker's own report. */
  brokerBookedTickets: number;
  /**
   * Share of tickets (0..1) carrying broker-booked costs. Below 1 the KPI is
   * partly the model grading itself — the card says so rather than implying
   * every number is invoiced.
   */
  brokerCoverage: number;
  /** Charged friction on invoiced tickets only — money the broker actually took. */
  realisedFrictionBase: number;
  /** Charged friction on the remaining tickets, still our estimate. */
  estimatedFrictionBase: number;
  daily: FrictionDailyPoint[];


  /** Annualised drag implied by the window's spend, in percent of NAV. */
  annualisedDragPct: number | null;
};

/**
 * Whether this fill's cost came off a broker invoice rather than the model.
 *
 * `fee_source` is authoritative once ingestion has run, but the tape predates
 * that column, so a positive booked fee also counts — otherwise historical
 * rows with real charges would be graded as estimates.
 */
export function isInvoiced(f: FrictionFill): boolean {
  if (f.feeSource === "broker") return true;
  if (f.feeSource === "model" || f.feeSource === "none") return false;
  return Number.isFinite(f.feeReportedBase) && f.feeReportedBase > 0;
}

/** Charged friction for one fill: the broker's number or ours, whichever is larger. */
export function chargedFriction(f: FrictionFill): number {
  const reported = Number.isFinite(f.feeReportedBase) ? Math.max(0, f.feeReportedBase) : 0;
  const modelled = Number.isFinite(f.feeModelledBase) ? Math.max(0, f.feeModelledBase) : 0;
  return Math.max(reported, modelled);
}


function dayKey(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

function scaleComponents(f: FrictionFill, charged: number): FrictionComponents {
  // Broker itemisation wins when we have it. Note the asymmetry: an invoice
  // bills commission, exchange fees and stamp duty but never the half-spread,
  // so any charge above the invoiced legs is exactly the implicit spread cost
  // the model priced — book the excess there rather than inflating commission.
  const rc = f.reportedComponents;
  if (rc) {
    const commission = Math.max(0, rc.commissionBase);
    const tax = Math.max(0, rc.taxBase);
    const spread = Math.max(0, rc.spreadBase);
    const invoiced = commission + tax + spread;
    if (invoiced > 0) {
      if (charged <= invoiced) {
        const k = charged / invoiced;
        return { commissionBase: commission * k, spreadBase: spread * k, taxBase: tax * k };
      }
      return { commissionBase: commission, spreadBase: spread + (charged - invoiced), taxBase: tax };
    }
  }

  const modelled =
    Math.max(0, f.commissionModelledBase) +
    Math.max(0, f.spreadModelledBase) +
    Math.max(0, f.taxModelledBase);
  // No modelled shape to apportion by (a zero-cost model, or a fill the model
  // could not price): book the whole charge as commission rather than losing it.
  if (!(modelled > 0)) return { commissionBase: charged, spreadBase: 0, taxBase: 0 };
  const k = charged / modelled;
  return {
    commissionBase: Math.max(0, f.commissionModelledBase) * k,
    spreadBase: Math.max(0, f.spreadModelledBase) * k,
    taxBase: Math.max(0, f.taxModelledBase) * k,
  };
}


export function computeFrictionKpi(args: {
  fills: readonly FrictionFill[];
  navBase: number;
  windowDays?: number;
  budgetBps?: number;
}): FrictionKpi {
  const windowDays = args.windowDays ?? FRICTION_WINDOW_DAYS;
  const budgetBps = args.budgetBps ?? FRICTION_BUDGET_BPS;
  const navBase = Number.isFinite(args.navBase) && args.navBase > 0 ? args.navBase : 0;

  const usable = args.fills.filter((f) => Number.isFinite(f.notionalBase) && f.notionalBase > 0);
  const ordered = [...usable].sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));

  let frictionBase = 0;
  let turnoverBase = 0;
  let reportedBase = 0;
  let modelledBase = 0;
  let realisedFrictionBase = 0;
  let estimatedFrictionBase = 0;
  let brokerBookedTickets = 0;
  // Ratio and coverage are read off invoiced tickets only. Averaging booked
  // fees over the whole tape would divide real charges by modelled costs the
  // broker never billed against, and report the model as twice as expensive
  // as reality purely because half the rows have not been synced yet.
  let invoicedReported = 0;
  let invoicedModelled = 0;
  const components: FrictionComponents = { commissionBase: 0, spreadBase: 0, taxBase: 0 };
  const byDay = new Map<string, { frictionBase: number; tickets: number }>();

  for (const f of ordered) {
    const charged = chargedFriction(f);
    frictionBase += charged;
    turnoverBase += Math.max(0, f.notionalBase);
    reportedBase += Math.max(0, f.feeReportedBase) || 0;
    modelledBase += Math.max(0, f.feeModelledBase) || 0;

    if (isInvoiced(f)) {
      brokerBookedTickets += 1;
      realisedFrictionBase += charged;
      invoicedReported += Math.max(0, f.feeReportedBase) || 0;
      invoicedModelled += Math.max(0, f.feeModelledBase) || 0;
    } else {
      estimatedFrictionBase += charged;
    }

    const c = scaleComponents(f, charged);
    components.commissionBase += c.commissionBase;
    components.spreadBase += c.spreadBase;
    components.taxBase += c.taxBase;

    const key = dayKey(f.filledAt);
    if (!key) continue;
    const bucket = byDay.get(key) ?? { frictionBase: 0, tickets: 0 };
    bucket.frictionBase += charged;
    bucket.tickets += 1;
    byDay.set(key, bucket);
  }

  const bpsOfNav = (v: number): number | null => (navBase > 0 ? (v / navBase) * 10_000 : null);

  let cumulative = 0;
  const daily: FrictionDailyPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, b]) => {
      cumulative += b.frictionBase;
      return {
        date,
        frictionBase: b.frictionBase,
        cumulativeBps: bpsOfNav(cumulative) ?? 0,
        tickets: b.tickets,
      };
    });

  const frictionBps = bpsOfNav(frictionBase);
  const tickets = ordered.length;


  return {
    windowDays,
    navBase,
    frictionBase,
    frictionBps,
    budgetBps,
    headroomBps: frictionBps == null ? null : budgetBps - frictionBps,
    breach: frictionBps != null && frictionBps > budgetBps,
    budgetUsed: frictionBps == null || budgetBps <= 0 ? null : frictionBps / budgetBps,
    tickets,
    turnoverBase,
    turnoverRatio: navBase > 0 ? turnoverBase / navBase : null,
    avgTicketBase: tickets > 0 ? turnoverBase / tickets : 0,
    components,
    reportedBase,
    modelledBase,
    realisedRatio: reportedBase > 0 && modelledBase > 0 ? reportedBase / modelledBase : null,
    brokerBookedTickets,
    brokerCoverage: tickets > 0 ? brokerBookedTickets / tickets : 0,
    daily,
    annualisedDragPct:
      frictionBps == null || windowDays <= 0
        ? null
        : (frictionBps / 100) * (365 / windowDays),
  };
}

// ---------------------------------------------------------------------------
// Item 18 — substitute realised costs into the friction ladder
// ---------------------------------------------------------------------------

/**
 * The multiplier shape `FrictionScenario` speaks, derived from the tape.
 *
 * Structural, not cosmetic: the commission leg is scaled by whatever the
 * broker actually charged relative to the model, and any friction the model
 * could not attribute to a named leg is carried as a flat `extraBps` on
 * notional so it cannot quietly vanish from the ladder.
 */
export type RealisedCostOverlay = {
  label: string;
  commissionMult: number;
  spreadMult: number;
  impactMult: number;
  extraBps: number;
  /** Fills the overlay was fitted on. */
  sampleFills: number;
  /** True when the broker booked no fees at all and the model stands unchallenged. */
  degraded: boolean;
  note: string;
};

/** Clamp a fitted multiplier into a range that cannot make the ladder absurd. */
const MULT_MIN = 0.25;
const MULT_MAX = 4;

export function realisedCostOverlay(args: {
  fills: readonly FrictionFill[];
  label?: string;
}): RealisedCostOverlay {
  const label = args.label ?? "realised";
  const fills = args.fills.filter((f) => Number.isFinite(f.notionalBase) && f.notionalBase > 0);

  let reportedCommission = 0;
  let modelledCommission = 0;
  let notional = 0;
  let unexplained = 0;

  for (const f of fills) {
    notional += f.notionalBase;
    const reported = Math.max(0, f.feeReportedBase) || 0;
    const modelledFee = Math.max(0, f.commissionModelledBase) + Math.max(0, f.taxModelledBase);
    reportedCommission += reported;
    modelledCommission += modelledFee;
    // Booked cost above every modelled leg is real money the ladder is not
    // pricing anywhere: FX markup, custody, a wider touch than we assumed.
    unexplained += Math.max(0, reported - Math.max(0, f.feeModelledBase));
  }

  if (!(reportedCommission > 0) || !(modelledCommission > 0)) {
    return {
      label,
      commissionMult: 1,
      spreadMult: 1,
      impactMult: 1,
      extraBps: 0,
      sampleFills: fills.length,
      degraded: true,
      note: "broker booked no fees on this tape — ladder runs on modelled costs",
    };
  }

  const raw = reportedCommission / modelledCommission;
  const commissionMult = Math.min(MULT_MAX, Math.max(MULT_MIN, raw));
  const extraBps = notional > 0 ? (unexplained / notional) * 10_000 : 0;

  return {
    label,
    commissionMult,
    spreadMult: 1,
    impactMult: 1,
    extraBps,
    sampleFills: fills.length,
    degraded: false,
    note:
      `broker commission ran ${raw.toFixed(2)}x the model` +
      (extraBps > 0.01 ? `, plus ${extraBps.toFixed(1)}bps unattributed` : ""),
  };
}

// ---------------------------------------------------------------------------
// Item 18 — before/after attribution
// ---------------------------------------------------------------------------

export type FrictionWindowStats = {
  label: string;
  fromIso: string | null;
  toIso: string | null;
  days: number;
  tickets: number;
  turnoverBase: number;
  avgTicketBase: number;
  frictionBase: number;
  frictionBps: number | null;
  /** Friction bps normalised to a 30-day window, so unequal spans compare. */
  frictionBpsPer30d: number | null;
  ticketsPerDay: number | null;
  /** Portfolio return over the window, percent, when equity marks are supplied. */
  returnPct: number | null;
};

export type BeforeAfterAttribution = {
  cutoverIso: string;
  before: FrictionWindowStats;
  after: FrictionWindowStats;
  /** after − before on the normalised metrics. */
  deltas: {
    frictionBpsPer30d: number | null;
    ticketsPerDay: number | null;
    avgTicketBase: number;
    returnPct: number | null;
  };
  /** Plain-English read of whether the changes bit. */
  verdict: "improved" | "unchanged" | "worse" | "insufficient_data";
};

export type EquityMark = { date: string; totalValue: number };

function windowReturnPct(equity: readonly EquityMark[], fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  // Equity marks are date-only (a day's close), so a window starting mid-day
  // still owns that day's mark — otherwise the opening mark falls outside its
  // own window and the return reads as unmeasurable.
  const fromRaw = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(fromRaw) || !Number.isFinite(to)) return null;
  const from = Date.parse(new Date(fromRaw).toISOString().slice(0, 10));
  const inRange = equity
    .filter((e) => {
      const t = Date.parse(e.date);
      return Number.isFinite(t) && t >= from && t <= to && Number.isFinite(e.totalValue);
    })
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (inRange.length < 2) return null;
  const start = inRange[0]!.totalValue;
  const end = inRange[inRange.length - 1]!.totalValue;
  if (!(start > 0)) return null;
  return ((end - start) / start) * 100;
}

function statsFor(args: {
  label: string;
  fills: readonly FrictionFill[];
  navBase: number;
  equity: readonly EquityMark[];
  boundFromIso: string | null;
  boundToIso: string | null;
}): FrictionWindowStats {
  const kpi = computeFrictionKpi({ fills: args.fills, navBase: args.navBase });
  const times = args.fills
    .map((f) => Date.parse(f.filledAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const fromIso = args.boundFromIso ?? (times.length > 0 ? new Date(times[0]!).toISOString() : null);
  const toIso =
    args.boundToIso ?? (times.length > 0 ? new Date(times[times.length - 1]!).toISOString() : null);
  const days =
    fromIso && toIso
      ? Math.max(1, (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000)
      : 0;

  return {
    label: args.label,
    fromIso,
    toIso,
    days,
    tickets: kpi.tickets,
    turnoverBase: kpi.turnoverBase,
    avgTicketBase: kpi.avgTicketBase,
    frictionBase: kpi.frictionBase,
    frictionBps: kpi.frictionBps,
    frictionBpsPer30d:
      kpi.frictionBps == null || days <= 0 ? null : kpi.frictionBps * (30 / days),
    ticketsPerDay: days > 0 ? kpi.tickets / days : null,
    returnPct: windowReturnPct(args.equity, fromIso, toIso),
  };
}

/** Minimum tickets on each side before a before/after read means anything. */
export const MIN_TICKETS_PER_SIDE = 5;

export function beforeAfterAttribution(args: {
  fills: readonly FrictionFill[];
  cutoverIso: string;
  navBase: number;
  equity?: readonly EquityMark[];
  fromIso?: string | null;
  toIso?: string | null;
}): BeforeAfterAttribution {
  const cut = Date.parse(args.cutoverIso);
  const equity = args.equity ?? [];
  const before: FrictionFill[] = [];
  const after: FrictionFill[] = [];
  for (const f of args.fills) {
    const t = Date.parse(f.filledAt);
    if (!Number.isFinite(t)) continue;
    (t < cut ? before : after).push(f);
  }

  const beforeStats = statsFor({
    label: "Before",
    fills: before,
    navBase: args.navBase,
    equity,
    boundFromIso: args.fromIso ?? null,
    boundToIso: args.cutoverIso,
  });
  const afterStats = statsFor({
    label: "After",
    fills: after,
    navBase: args.navBase,
    equity,
    boundFromIso: args.cutoverIso,
    boundToIso: args.toIso ?? null,
  });

  const dFriction =
    beforeStats.frictionBpsPer30d == null || afterStats.frictionBpsPer30d == null
      ? null
      : afterStats.frictionBpsPer30d - beforeStats.frictionBpsPer30d;
  const dTickets =
    beforeStats.ticketsPerDay == null || afterStats.ticketsPerDay == null
      ? null
      : afterStats.ticketsPerDay - beforeStats.ticketsPerDay;
  const dReturn =
    beforeStats.returnPct == null || afterStats.returnPct == null
      ? null
      : afterStats.returnPct - beforeStats.returnPct;

  let verdict: BeforeAfterAttribution["verdict"] = "insufficient_data";
  if (
    before.length >= MIN_TICKETS_PER_SIDE &&
    after.length >= MIN_TICKETS_PER_SIDE &&
    dFriction != null
  ) {
    // A 2bps/30d move is inside the noise of a fortnight's tape.
    if (dFriction < -2) verdict = "improved";
    else if (dFriction > 2) verdict = "worse";
    else verdict = "unchanged";
  }

  return {
    cutoverIso: args.cutoverIso,
    before: beforeStats,
    after: afterStats,
    deltas: {
      frictionBpsPer30d: dFriction,
      ticketsPerDay: dTickets,
      avgTicketBase: afterStats.avgTicketBase - beforeStats.avgTicketBase,
      returnPct: dReturn,
    },
    verdict,
  };
}
