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
    realisedRatio:
      invoicedReported > 0 && invoicedModelled > 0 ? invoicedReported / invoicedModelled : null,
    brokerBookedTickets,
    brokerCoverage: tickets > 0 ? brokerBookedTickets / tickets : 0,
    realisedFrictionBase,
    estimatedFrictionBase,
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
 *
 * Fitted on invoiced fills only. Including un-synced fills would put real
 * charges over the whole tape's modelled cost and halve the multiplier for no
 * reason other than incomplete ingestion — the ladder would then be told
 * trading is cheaper than the broker's own invoice says.
 */
export type RealisedCostOverlay = {
  label: string;
  commissionMult: number;
  spreadMult: number;
  impactMult: number;
  extraBps: number;
  /** Invoiced fills the overlay was fitted on. */
  sampleFills: number;
  /** Fills in the tape, invoiced or not — the denominator behind `coverage`. */
  totalFills: number;
  /** Share of the tape (0..1) carrying broker-booked fees. */
  coverage: number;
  /** True only when no fill carries a broker fee, so the model stands unchallenged. */
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
  const invoiced = fills.filter((f) => isInvoiced(f) && (Math.max(0, f.feeReportedBase) || 0) > 0);
  const coverage = fills.length > 0 ? invoiced.length / fills.length : 0;

  let reportedCommission = 0;
  let modelledCommission = 0;
  let notional = 0;
  let unexplained = 0;

  for (const f of invoiced) {
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
      sampleFills: invoiced.length,
      totalFills: fills.length,
      coverage,
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
    sampleFills: invoiced.length,
    totalFills: fills.length,
    coverage,
    degraded: false,
    note:
      `broker commission ran ${raw.toFixed(2)}x the model` +
      (extraBps > 0.01 ? `, plus ${extraBps.toFixed(1)}bps unattributed` : "") +
      (coverage < 0.999
        ? ` (fitted on ${invoiced.length} of ${fills.length} trades with booked fees)`
        : ""),
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

// ---------------------------------------------------------------------------
// Trailing friction over time
// ---------------------------------------------------------------------------

/**
 * One calendar day's read of the KPI: what the *trailing 30 days* of trading
 * cost, as bps of that day's NAV.
 *
 * Rolling, not cumulative-since-window-start. The budget is "40bps per 30
 * days", so only a trailing-30d number is comparable to the reference line on
 * every day of the chart; a running total starts near zero and can only cross
 * the line at the right-hand edge, which reads as "we were fine until today"
 * even during a month of sustained overspend.
 */
export type FrictionSeriesPoint = {
  /** UTC day key, YYYY-MM-DD. */
  date: string;
  /** Friction charged inside the trailing window ending this day, base currency. */
  frictionBase: number;
  /** That friction as bps of the day's NAV. `null` when NAV is unknown. */
  frictionBps: number | null;
  /** Tickets inside the trailing window. */
  tickets: number;
  /** Friction charged on this day alone, base currency. */
  dayFrictionBase: number;
  /** Over the budget line on this day. */
  breach: boolean;
};

function addDays(dayIso: string, n: number): string {
  return new Date(Date.parse(`${dayIso}T00:00:00.000Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Daily trailing-window friction across the last `days` calendar days.
 *
 * Emits every day in range, including days with no trades: a quiet week is
 * information (the trailing number decays), and dropping those rows would
 * squash the x-axis so a burst of trading looks evenly paced.
 */
export function frictionTimeSeries(args: {
  fills: readonly FrictionFill[];
  /** Fallback NAV for days with no snapshot. */
  navBase: number;
  /** Per-day NAV, base currency, when equity snapshots are available. */
  navByDay?: ReadonlyMap<string, number> | Record<string, number>;
  /** Length of the chart, in calendar days. */
  days: number;
  /** Length of the trailing window each point measures. */
  windowDays?: number;
  budgetBps?: number;
  /** End of the chart. Defaults to now. */
  now?: Date;
}): FrictionSeriesPoint[] {
  const windowDays = args.windowDays ?? FRICTION_WINDOW_DAYS;
  const budgetBps = args.budgetBps ?? FRICTION_BUDGET_BPS;
  const days = Math.max(1, Math.floor(args.days));
  const fallbackNav = Number.isFinite(args.navBase) && args.navBase > 0 ? args.navBase : 0;
  const navMap =
    args.navByDay instanceof Map
      ? args.navByDay
      : new Map(Object.entries(args.navByDay ?? {}).map(([k, v]) => [k, Number(v)]));

  const end = (args.now ?? new Date()).toISOString().slice(0, 10);
  const start = addDays(end, -(days - 1));

  const byDay = new Map<string, { frictionBase: number; tickets: number }>();
  for (const f of args.fills) {
    if (!(Number.isFinite(f.notionalBase) && f.notionalBase > 0)) continue;
    const key = dayKey(f.filledAt);
    if (!key || key > end) continue;
    const b = byDay.get(key) ?? { frictionBase: 0, tickets: 0 };
    b.frictionBase += chargedFriction(f);
    b.tickets += 1;
    byDay.set(key, b);
  }

  // Carry the last known NAV forward: snapshots are only written on days the
  // valuation ran, and a missing weekend must not blank the line.
  let carriedNav = 0;
  for (const [d, v] of [...navMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (d <= start && Number.isFinite(v) && v > 0) carriedNav = v;
  }

  const out: FrictionSeriesPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(start, i);
    const snapNav = navMap.get(date);
    if (Number.isFinite(snapNav) && (snapNav as number) > 0) carriedNav = snapNav as number;
    const nav = carriedNav > 0 ? carriedNav : fallbackNav;

    let frictionBase = 0;
    let tickets = 0;
    for (let k = 0; k < windowDays; k += 1) {
      const b = byDay.get(addDays(date, -k));
      if (!b) continue;
      frictionBase += b.frictionBase;
      tickets += b.tickets;
    }
    const frictionBps = nav > 0 ? (frictionBase / nav) * 10_000 : null;
    out.push({
      date,
      frictionBase,
      frictionBps,
      tickets,
      dayFrictionBase: byDay.get(date)?.frictionBase ?? 0,
      breach: frictionBps != null && frictionBps > budgetBps,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drilldown — realised vs modelled cost by asset and by venue
// ---------------------------------------------------------------------------

/**
 * Where a symbol trades, as far as costs are concerned.
 *
 * Venue is the right axis for a cost drilldown because the three legs are
 * charged by different parties: commission scales with the broker's per-market
 * tier, the buy/sell gap with that market's liquidity, and stamp duty exists
 * only on a handful of exchanges (0.5% on UK shares, nothing on US ones). A
 * per-asset view alone would hide that a single venue is doing the damage.
 */
export function venueOf(symbol: string): string {
  const s = String(symbol ?? "").trim().toUpperCase();
  if (!s) return "UNKNOWN";
  // Broker-native form (`AAPL:XNAS`) carries the MIC outright.
  const colon = s.lastIndexOf(":");
  if (colon > 0) {
    const mic = s.slice(colon + 1).replace(/[^A-Z0-9]/g, "");
    if (mic.length >= 3) return mic;
  }
  if (/(^|[-/])(BTC|ETH|SOL|XRP|ADA|DOGE)([-/]|$)/.test(s) || s.includes("-USD")) return "CRYPTO";
  const suffix = s.includes(".") ? s.slice(s.lastIndexOf(".") + 1) : "";
  const bySuffix: Record<string, string> = {
    L: "XLON",
    DE: "XETR",
    PA: "XPAR",
    AS: "XAMS",
    MI: "XMIL",
    SW: "XSWX",
    MC: "XMAD",
    ST: "XSTO",
    CO: "XCSE",
    OL: "XOSL",
    HE: "XHEL",
    TO: "XTSE",
    HK: "XHKG",
    T: "XTKS",
    AX: "XASX",
  };
  if (suffix && bySuffix[suffix]) return bySuffix[suffix]!;
  return "US";
}

export type FrictionBreakdownRow = {
  /** Symbol or venue code, depending on the grouping. */
  key: string;
  tickets: number;
  turnoverBase: number;
  /** Charged friction (broker's number or ours, whichever is larger). */
  chargedBase: number;
  /** Charged friction as bps of the group's own turnover. */
  chargedBpsOfTurnover: number | null;
  /** Sum of broker-booked fees on this group. */
  reportedBase: number;
  /** Sum of modelled one-way friction on this group. */
  modelledBase: number;
  /** Reported ÷ modelled across invoiced tickets only. `null` with no invoices. */
  realisedRatio: number | null;
  /** Tickets on this group carrying broker-booked costs. */
  invoicedTickets: number;
  /** Share of this group's tickets that are invoiced (0..1). */
  brokerCoverage: number;
  /** Charged split into broker charges / buy-sell gap / stamp duty. */
  components: FrictionComponents;
  /** The model's own split, for the realised-vs-modelled comparison. */
  modelledComponents: FrictionComponents;
};

export type FrictionBreakdown = {
  by: "asset" | "venue";
  rows: FrictionBreakdownRow[];
  totals: FrictionBreakdownRow;
};

function emptyRow(key: string): FrictionBreakdownRow {
  return {
    key,
    tickets: 0,
    turnoverBase: 0,
    chargedBase: 0,
    chargedBpsOfTurnover: null,
    reportedBase: 0,
    modelledBase: 0,
    realisedRatio: null,
    invoicedTickets: 0,
    brokerCoverage: 0,
    components: { commissionBase: 0, spreadBase: 0, taxBase: 0 },
    modelledComponents: { commissionBase: 0, spreadBase: 0, taxBase: 0 },
  };
}

/**
 * Realised vs modelled cost, split by asset or by venue.
 *
 * Same charging rule as the headline KPI (`chargedFriction`), so the rows sum
 * to the card's total rather than telling a second story. Ratio and coverage
 * are computed on invoiced tickets only for the same reason as the KPI: a
 * group whose fees have not synced yet is missing data, not a cheap venue.
 */
export function frictionBreakdown(args: {
  fills: readonly FrictionFill[];
  by: "asset" | "venue";
  /** Rows to keep, largest charged cost first. The rest fold into "Other". */
  limit?: number;
}): FrictionBreakdown {
  const limit = args.limit ?? 12;
  const groups = new Map<string, FrictionBreakdownRow>();
  const invoicedSums = new Map<string, { reported: number; modelled: number }>();
  const totals = emptyRow("all");
  let totalInvoicedReported = 0;
  let totalInvoicedModelled = 0;

  for (const f of args.fills) {
    if (!(Number.isFinite(f.notionalBase) && f.notionalBase > 0)) continue;
    const key = args.by === "venue" ? venueOf(f.symbol) : String(f.symbol || "UNKNOWN");
    const row = groups.get(key) ?? emptyRow(key);
    const charged = chargedFriction(f);
    const reported = Math.max(0, f.feeReportedBase) || 0;
    const modelled = Math.max(0, f.feeModelledBase) || 0;
    const comp = scaleComponents(f, charged);

    for (const target of [row, totals]) {
      target.tickets += 1;
      target.turnoverBase += f.notionalBase;
      target.chargedBase += charged;
      target.reportedBase += reported;
      target.modelledBase += modelled;
      target.components.commissionBase += comp.commissionBase;
      target.components.spreadBase += comp.spreadBase;
      target.components.taxBase += comp.taxBase;
      target.modelledComponents.commissionBase += Math.max(0, f.commissionModelledBase) || 0;
      target.modelledComponents.spreadBase += Math.max(0, f.spreadModelledBase) || 0;
      target.modelledComponents.taxBase += Math.max(0, f.taxModelledBase) || 0;
    }

    if (isInvoiced(f)) {
      row.invoicedTickets += 1;
      totals.invoicedTickets += 1;
      const s = invoicedSums.get(key) ?? { reported: 0, modelled: 0 };
      s.reported += reported;
      s.modelled += modelled;
      invoicedSums.set(key, s);
      totalInvoicedReported += reported;
      totalInvoicedModelled += modelled;
    }

    groups.set(key, row);
  }

  const finish = (row: FrictionBreakdownRow, inv: { reported: number; modelled: number }) => {
    row.chargedBpsOfTurnover =
      row.turnoverBase > 0 ? (row.chargedBase / row.turnoverBase) * 10_000 : null;
    row.realisedRatio = inv.reported > 0 && inv.modelled > 0 ? inv.reported / inv.modelled : null;
    row.brokerCoverage = row.tickets > 0 ? row.invoicedTickets / row.tickets : 0;
    return row;
  };

  const all = [...groups.values()]
    .map((r) => finish(r, invoicedSums.get(r.key) ?? { reported: 0, modelled: 0 }))
    .sort((a, b) => b.chargedBase - a.chargedBase);

  let rows = all;
  if (all.length > limit) {
    const head = all.slice(0, limit - 1);
    const tail = all.slice(limit - 1);
    const other = emptyRow("Other");
    let oReported = 0;
    let oModelled = 0;
    for (const r of tail) {
      other.tickets += r.tickets;
      other.turnoverBase += r.turnoverBase;
      other.chargedBase += r.chargedBase;
      other.reportedBase += r.reportedBase;
      other.modelledBase += r.modelledBase;
      other.invoicedTickets += r.invoicedTickets;
      other.components.commissionBase += r.components.commissionBase;
      other.components.spreadBase += r.components.spreadBase;
      other.components.taxBase += r.components.taxBase;
      other.modelledComponents.commissionBase += r.modelledComponents.commissionBase;
      other.modelledComponents.spreadBase += r.modelledComponents.spreadBase;
      other.modelledComponents.taxBase += r.modelledComponents.taxBase;
      const s = invoicedSums.get(r.key);
      if (s) {
        oReported += s.reported;
        oModelled += s.modelled;
      }
    }
    rows = [...head, finish(other, { reported: oReported, modelled: oModelled })];
  }

  return {
    by: args.by,
    rows,
    totals: finish(totals, { reported: totalInvoicedReported, modelled: totalInvoicedModelled }),
  };
}

/* ------------------------------------------------------------------ *
 * Weekly cost ledger
 *
 * The headline KPI answers "are we over budget right now"; it cannot show
 * *when* the money leaked. This cut lays the same charged-friction rule over
 * calendar weeks (Monday-start, UK clock) and splits each week into the three
 * things a real-cash account actually pays: broker commission, stamp duty and
 * levies, and the spread we cross. Turnover and ticket counts sit beside them
 * so a bad week reads as either "traded too much" or "paid too much per trade".
 * ------------------------------------------------------------------ */

export type FrictionWeekRow = {
  /** Monday of the week, YYYY-MM-DD (UK clock). */
  weekStart: string;
  /** Sunday of the week, YYYY-MM-DD. */
  weekEnd: string;
  tickets: number;
  buyTickets: number;
  sellTickets: number;
  /** Total traded notional, base currency. */
  turnoverBase: number;
  buyTurnoverBase: number;
  sellTurnoverBase: number;
  /** Turnover as a fraction of the week's NAV (1.0 = whole book churned). */
  turnoverRatio: number | null;
  /** Charged friction, base currency (broker's number or ours, larger wins). */
  chargedBase: number;
  /** Commission / stamp+levies / spread split of `chargedBase`. */
  components: FrictionComponents;
  /** Charged friction in bps of the week's own turnover. */
  chargedBpsOfTurnover: number | null;
  /** Charged friction in bps of the week's NAV — comparable to the budget. */
  chargedBpsOfNav: number | null;
  /** Average ticket size, base currency. */
  avgTicketBase: number;
  /** NAV used for the bps-of-NAV figure. */
  navBase: number | null;
  /** Share of the week's tickets carrying broker-booked charges (0..1). */
  brokerCoverage: number;
};

export type WeeklyFrictionLedger = {
  weeks: FrictionWeekRow[];
  totals: FrictionWeekRow;
  /** Weekly slice of the 40bps/30d budget, for the reference line. */
  weeklyBudgetBps: number;
  currencyHint?: string;
};

/** Monday-start week key for an instant, evaluated on the UK clock. */
export function ukWeekStart(iso: string): string {
  const d = new Date(Date.parse(iso));
  if (Number.isNaN(d.getTime())) return "";
  // London is UTC+0/+1; shifting by the zone offset keeps Sunday-night fills
  // in the right week without pulling in a date library.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const local = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  const dow = (local.getUTCDay() + 6) % 7; // Monday = 0
  local.setUTCDate(local.getUTCDate() - dow);
  return local.toISOString().slice(0, 10);
}


function emptyWeek(weekStart: string): FrictionWeekRow {
  return {
    weekStart,
    weekEnd: weekStart ? addDays(weekStart, 6) : "",
    tickets: 0,
    buyTickets: 0,
    sellTickets: 0,
    turnoverBase: 0,
    buyTurnoverBase: 0,
    sellTurnoverBase: 0,
    turnoverRatio: null,
    chargedBase: 0,
    components: { commissionBase: 0, spreadBase: 0, taxBase: 0 },
    chargedBpsOfTurnover: null,
    chargedBpsOfNav: null,
    avgTicketBase: 0,
    navBase: null,
    brokerCoverage: 0,
  };
}

/**
 * Per-week cost ledger over the supplied tape.
 *
 * `navByDay` is optional: when a week has no snapshot the NAV-relative
 * columns are left null rather than divided by a stale number, because a
 * wrong denominator here would make a cheap week look expensive.
 */
export function weeklyFrictionLedger(args: {
  fills: readonly FrictionFill[];
  /** Fallback NAV when a week has no snapshot of its own. */
  navBase?: number;
  /** YYYY-MM-DD → NAV, used to pick each week's own denominator. */
  navByDay?: Map<string, number>;
  /** Most recent weeks to return (default 13 ≈ a quarter). */
  limitWeeks?: number;
}): WeeklyFrictionLedger {
  const limit = Math.max(1, args.limitWeeks ?? 13);
  const byWeek = new Map<string, FrictionWeekRow>();
  const invoiced = new Map<string, number>();

  for (const f of args.fills) {
    if (!(Number.isFinite(f.notionalBase) && f.notionalBase > 0)) continue;
    const week = ukWeekStart(f.filledAt);
    if (!week) continue;
    const row = byWeek.get(week) ?? emptyWeek(week);
    const charged = chargedFriction(f);
    const comp = scaleComponents(f, charged);

    row.tickets += 1;
    row.turnoverBase += f.notionalBase;
    if (f.side === "sell") {
      row.sellTickets += 1;
      row.sellTurnoverBase += f.notionalBase;
    } else {
      row.buyTickets += 1;
      row.buyTurnoverBase += f.notionalBase;
    }
    row.chargedBase += charged;
    row.components.commissionBase += comp.commissionBase;
    row.components.spreadBase += comp.spreadBase;
    row.components.taxBase += comp.taxBase;
    if (isInvoiced(f)) invoiced.set(week, (invoiced.get(week) ?? 0) + 1);
    byWeek.set(week, row);
  }

  const navFor = (weekStart: string): number | null => {
    if (args.navByDay) {
      for (let i = 6; i >= 0; i--) {
        const nav = args.navByDay.get(addDays(weekStart, i));
        if (Number.isFinite(nav) && (nav as number) > 0) return nav as number;
      }
    }
    const fallback = Number(args.navBase ?? 0);
    return fallback > 0 ? fallback : null;
  };

  const finish = (row: FrictionWeekRow, invoicedTickets: number): FrictionWeekRow => {
    const nav = row.navBase ?? navFor(row.weekStart);
    row.navBase = nav;
    row.avgTicketBase = row.tickets > 0 ? row.turnoverBase / row.tickets : 0;
    row.chargedBpsOfTurnover =
      row.turnoverBase > 0 ? (row.chargedBase / row.turnoverBase) * 10_000 : null;
    row.chargedBpsOfNav = nav && nav > 0 ? (row.chargedBase / nav) * 10_000 : null;
    row.turnoverRatio = nav && nav > 0 ? row.turnoverBase / nav : null;
    row.brokerCoverage = row.tickets > 0 ? invoicedTickets / row.tickets : 0;
    return row;
  };

  const weeks = [...byWeek.values()]
    .map((r) => finish(r, invoiced.get(r.weekStart) ?? 0))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0))
    .slice(-limit);

  const totals = emptyWeek(weeks[0]?.weekStart ?? "");
  totals.weekEnd = weeks[weeks.length - 1]?.weekEnd ?? "";
  let totalInvoiced = 0;
  let navSum = 0;
  let navCount = 0;
  for (const w of weeks) {
    totals.tickets += w.tickets;
    totals.buyTickets += w.buyTickets;
    totals.sellTickets += w.sellTickets;
    totals.turnoverBase += w.turnoverBase;
    totals.buyTurnoverBase += w.buyTurnoverBase;
    totals.sellTurnoverBase += w.sellTurnoverBase;
    totals.chargedBase += w.chargedBase;
    totals.components.commissionBase += w.components.commissionBase;
    totals.components.spreadBase += w.components.spreadBase;
    totals.components.taxBase += w.components.taxBase;
    totalInvoiced += Math.round(w.brokerCoverage * w.tickets);
    if (w.navBase && w.navBase > 0) {
      navSum += w.navBase;
      navCount += 1;
    }
  }
  totals.navBase = navCount > 0 ? navSum / navCount : null;
  finish(totals, totalInvoiced);

  return {
    weeks,
    totals,
    // 40bps per 30 days ≈ 9.3bps per 7-day week.
    weeklyBudgetBps: (FRICTION_BUDGET_BPS * 7) / FRICTION_WINDOW_DAYS,
  };
}
