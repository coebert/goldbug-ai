// Core-allocation progress: how much of the owner-set core is actually built,
// what it still costs to finish, and when it will get there at the observed
// pace. Pure module — the caller resolves NAV, the core holding's value, cash,
// and the recent core buy history.

export type CoreProgressInput = {
  /** Account value, base currency. */
  navBase: number;
  /** Market value of the core holding today, base currency. */
  coreValueBase: number;
  /** Free cash, base currency. */
  cashBase: number;
  /** Cash held back for settlement and fees. */
  cashReserveBase: number;
  /** Target share of NAV in the core, 0–1 (0 = policy off). */
  targetPct: number;
  /** Drift band either side of the target. */
  bandPct: number;
  /** Smallest worthwhile ticket, base currency. */
  minTicketBase: number;
  /** Core buys filled recently: base-currency amounts with their dates. */
  recentCoreBuys: Array<{ date: string; amountBase: number }>;
  /** Days the recent-buy window covers (default 60). */
  windowDays?: number;
  /** Round-trip dealing cost estimate in bps, used for the fee estimate. */
  roundTripBps?: number | null;
  /** Today, ISO date. Injected for deterministic tests. */
  today?: string;
};

export type CoreProgressResult = {
  enabled: boolean;
  targetPct: number;
  currentPct: number;
  /** 0–1 share of the target that is already built. */
  builtFraction: number;
  targetValueBase: number;
  coreValueBase: number;
  /** Still to buy to reach the target (0 when at or above it). */
  gapBase: number;
  /** Cash the gap needs, including an estimate of dealing charges. */
  cashNeededBase: number;
  estimatedFeesBase: number;
  deployableCashBase: number;
  /** Cash still to be found beyond what is deployable today. */
  cashShortfallBase: number;
  /** Number of minimum-size tickets the gap still needs. */
  ticketsRemaining: number;
  /** Observed build rate, base currency per day (null when no core buys yet). */
  paceBasePerDay: number | null;
  /** Projected completion date at that pace (null when unknown). */
  projectedDate: string | null;
  /** Days to completion at that pace. */
  projectedDays: number | null;
  /** Inside the drift band — no top-up is due. */
  withinBand: boolean;
  /** Above target by more than the band — a trim is due instead. */
  overTarget: boolean;
  note: string;
};

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function computeCoreProgress(input: CoreProgressInput): CoreProgressResult {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const nav = Math.max(0, Number(input.navBase) || 0);
  const coreValue = Math.max(0, Number(input.coreValueBase) || 0);
  const targetPct = Math.min(0.95, Math.max(0, Number(input.targetPct) || 0));
  const bandPct = Math.min(0.3, Math.max(0, Number(input.bandPct) || 0));
  const targetValue = nav * targetPct;
  const currentPct = nav > 0 ? coreValue / nav : 0;
  const gap = Math.max(0, targetValue - coreValue);
  const bps = Number(input.roundTripBps);
  const feeRate = Number.isFinite(bps) && bps > 0 ? bps / 10_000 / 2 : 0.005;
  const fees = gap * feeRate;
  const deployable = Math.max(0, (Number(input.cashBase) || 0) - (Number(input.cashReserveBase) || 0));
  const cashNeeded = gap + fees;
  const minTicket = Math.max(1, Number(input.minTicketBase) || 1);

  const windowDays = Math.max(1, Number(input.windowDays ?? 60));
  const cutoff = addDays(today, -windowDays);
  const bought = (input.recentCoreBuys ?? [])
    .filter((b) => String(b.date) >= cutoff)
    .reduce((s, b) => s + Math.max(0, Number(b.amountBase) || 0), 0);
  const pace = bought > 0 ? bought / windowDays : null;

  const projectedDays = pace && pace > 0 && gap > 0 ? Math.ceil(gap / pace) : gap > 0 ? null : 0;
  const projectedDate =
    projectedDays === 0 ? today : projectedDays != null ? addDays(today, projectedDays) : null;

  const withinBand = nav > 0 && Math.abs(currentPct - targetPct) <= bandPct;
  const overTarget = nav > 0 && currentPct - targetPct > bandPct;

  let note: string;
  if (targetPct <= 0) note = "Core allocation is switched off.";
  else if (overTarget) note = "The core is above its target band — a trim is due, not a top-up.";
  else if (gap <= 0) note = "The core is fully built.";
  else if (withinBand) note = "Inside the drift band — no top-up is due right now.";
  else if (deployable < minTicket)
    note = "Not enough spare cash for a worthwhile top-up; the core waits for cash to build.";
  else if (pace == null) note = "No core buys yet, so no completion date can be estimated.";
  else note = "Building at the recent pace.";

  return {
    enabled: targetPct > 0,
    targetPct,
    currentPct,
    builtFraction: targetValue > 0 ? Math.min(1, coreValue / targetValue) : 0,
    targetValueBase: targetValue,
    coreValueBase: coreValue,
    gapBase: gap,
    cashNeededBase: cashNeeded,
    estimatedFeesBase: fees,
    deployableCashBase: deployable,
    cashShortfallBase: Math.max(0, cashNeeded - deployable),
    ticketsRemaining: gap > 0 ? Math.ceil(gap / minTicket) : 0,
    paceBasePerDay: pace,
    projectedDate,
    projectedDays,
    withinBand,
    overTarget,
    note,
  };
}
