// Phase 3 item 12 — event gating around scheduled earnings.
//
// Holding into a print is a coin flip the alpha models were never fitted
// on. New entries inside the blackout window are vetoed; entries just
// outside it are haircut. Exits are never gated — we must always be able
// to leave a position.
//
// Pure module: the earnings dates are fetched by the caller
// (see events/earnings-cache.server.ts) and passed in.

export type EarningsGateInput = {
  side: "buy" | "sell";
  /** ISO yyyy-mm-dd of the run. */
  asOf: string;
  /** ISO yyyy-mm-dd of the next scheduled report, or null when unknown. */
  nextEarningsDate: string | null | undefined;
  /** Provider confidence: "confirmed" gates hard, anything else haircuts. */
  confidence?: string | null;
  /** Days before the print during which new entries are vetoed. */
  vetoDays?: number;
  /** Days before the print during which entries are haircut. */
  haircutDays?: number;
};

export type EarningsGateResult = {
  /** True when a fresh entry must be rejected outright. */
  veto: boolean;
  /** Size multiplier in (0, 1]; 1 when the gate is inactive. */
  mult: number;
  /** Whole days until the print, or null when unknown. */
  daysUntil: number | null;
  /** Audit note, or null when the gate did nothing. */
  note: string | null;
};

export const DEFAULT_VETO_DAYS = 2;
export const DEFAULT_HAIRCUT_DAYS = 5;
const HAIRCUT_MULT = 0.6;

function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export function earningsGate(input: EarningsGateInput): EarningsGateResult {
  const inactive: EarningsGateResult = { veto: false, mult: 1, daysUntil: null, note: null };
  if (input.side === "sell") return inactive;
  if (!input.nextEarningsDate) return inactive;

  const days = daysBetween(input.asOf, input.nextEarningsDate);
  if (days == null || days < 0) return inactive;

  const vetoDays = Math.max(0, input.vetoDays ?? DEFAULT_VETO_DAYS);
  const haircutDays = Math.max(vetoDays, input.haircutDays ?? DEFAULT_HAIRCUT_DAYS);
  const confirmed = String(input.confidence ?? "").toLowerCase() === "confirmed";

  if (days <= vetoDays) {
    if (confirmed) {
      return {
        veto: true,
        mult: 1,
        daysUntil: days,
        note: `earnings in ${days}d (confirmed) — no new entry`,
      };
    }
    return {
      veto: false,
      mult: HAIRCUT_MULT,
      daysUntil: days,
      note: `earnings in ${days}d (estimated) ×${HAIRCUT_MULT.toFixed(2)}`,
    };
  }

  if (days <= haircutDays) {
    return {
      veto: false,
      mult: HAIRCUT_MULT,
      daysUntil: days,
      note: `earnings in ${days}d ×${HAIRCUT_MULT.toFixed(2)}`,
    };
  }

  return { ...inactive, daysUntil: days };
}
