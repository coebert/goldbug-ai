// Cash-equity settlement date helper.
//
// Pure, dependency-free. Given a trade date and venue, returns the expected
// settlement date. TSE (Tokyo) and ASX (Australia) both settle T+2 business
// days for cash equities; NYSE/LSE match. Weekends are skipped; caller can
// pass venue-specific holidays via `skipDates`.
//
// Wallet accounting uses this to date the debit/credit that funds the trade
// (native-currency leg) and the FX conversion leg. Settlement dates only
// affect *when* balances move — they do not change the notional or the FX
// rate captured at trade time.

export type SettlementVenue =
  | "LSE"
  | "NYSE"
  | "NASDAQ"
  | "TSE_JP"
  | "ASX"
  | "OTHER";

// T+N (business days) per venue. Cash equities in all four major venues
// currently settle T+2; keep this table explicit so we can adjust if a
// venue migrates (e.g. US to T+1) without touching call sites.
const SETTLEMENT_LAG_DAYS: Record<SettlementVenue, number> = {
  LSE: 2,
  NYSE: 2,
  NASDAQ: 2,
  TSE_JP: 2,
  ASX: 2,
  OTHER: 2,
};

export function settlementLagDays(venue: SettlementVenue): number {
  return SETTLEMENT_LAG_DAYS[venue];
}

// UTC date arithmetic to avoid TZ drift when advancing business days.
function toUtcDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function toYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Advance `n` business days from `start`, skipping weekends and `skipDates`. */
export function addBusinessDays(
  start: Date,
  n: number,
  skipDates: ReadonlySet<string> = new Set(),
): Date {
  let cur = toUtcDateOnly(start);
  let remaining = n;
  while (remaining > 0) {
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
    if (isWeekend(cur)) continue;
    if (skipDates.has(toYmd(cur))) continue;
    remaining -= 1;
  }
  return cur;
}

/**
 * Settlement date for a cash-equity trade at `venue`, given the trade date.
 *
 * `skipDates` is an ISO YYYY-MM-DD set of venue holidays to skip in addition
 * to weekends. Callers with no holiday calendar can omit it.
 */
export function settlementDate(
  tradeDate: Date,
  venue: SettlementVenue,
  skipDates?: ReadonlySet<string>,
): Date {
  return addBusinessDays(tradeDate, settlementLagDays(venue), skipDates);
}

/**
 * FX spot settlement date. Interbank spot convention is T+2 for majors
 * except USD/CAD (T+1). Cross-venue trades that need an FX leg to fund the
 * native-currency debit typically want the FX to settle *before* the equity
 * settles, so the wallet has cleared local-ccy cash on the equity settle
 * date. Callers should pass the trade date for the FX; we return T+2 for
 * all pairs we currently support (JPY, AUD, USD, EUR, CHF).
 *
 * If the pair is USDCAD in either direction, returns T+1.
 */
export function fxSettlementDate(
  tradeDate: Date,
  fromCcy: string,
  toCcy: string,
  skipDates?: ReadonlySet<string>,
): Date {
  const pair = `${fromCcy.toUpperCase()}${toCcy.toUpperCase()}`;
  const lag = pair === "USDCAD" || pair === "CADUSD" ? 1 : 2;
  return addBusinessDays(tradeDate, lag, skipDates);
}
