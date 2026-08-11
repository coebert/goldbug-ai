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
};

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
export function edgePerCost(c: GovernorCandidate): number {
  const conviction = Number.isFinite(c.edgeScore)
    ? Math.min(1, Math.max(0, Number(c.edgeScore)))
    : 0.5;
  const move = Number.isFinite(c.expectedMovePct)
    ? Math.max(0, Number(c.expectedMovePct))
    : 0.02;
  const grossEdge = conviction * move * Math.max(0, c.notionalBase);
  const cost = Math.max(0.01, c.estCostBase);
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
  const budgetTotal = Math.max(0, cfg.navBase) * Math.max(0, cfg.costBudgetPctOfNav);
  let budgetLeft = Math.max(0, budgetTotal - Math.max(0, cfg.trailingCostBase));
  let buysAdmitted = 0;
  const roomToday = Math.max(0, cfg.maxBuysPerDay - Math.max(0, cfg.buysAlreadyToday));

  const decisions: GovernorDecision[] = [];
  const sells = candidates.filter((c) => c.side === "sell");
  const buys = candidates
    .filter((c) => c.side === "buy")
    .slice()
    .sort((a, b) => {
      const diff = edgePerCost(b) - edgePerCost(a);
      if (Math.abs(diff) > 1e-9) return diff;
      return b.notionalBase - a.notionalBase;
    });


  for (const c of sells) decisions.push({ kind: "admit", candidate: c });

  for (const c of buys) {
    const cooldown = cfg.lastBuyDaysAgo[c.symbol];
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
      decisions.push({
        kind: "skip",
        candidate: c,
        reason:
          `trailing cost budget exhausted: ${cfg.trailingCostBase.toFixed(2)} of ` +
          `${budgetTotal.toFixed(2)} (${(cfg.costBudgetPctOfNav * 100).toFixed(2)}% of NAV) spent; ` +
          `this ticket needs ${c.estCostBase.toFixed(2)}`,
      });
      continue;
    }

    budgetLeft -= c.estCostBase;
    buysAdmitted += 1;
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

