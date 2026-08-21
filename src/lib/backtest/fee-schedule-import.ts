// Import a broker's published fee schedule and turn it into backtest defaults.
//
// Every cost number in a replay currently leans on `SAXO_FEE_SCHEDULE` — our
// hand-maintained copy of the Classic tier. That copy goes stale the moment a
// broker re-prices a venue, moves the account to a different tier, or a
// jurisdiction changes its transaction tax. Rather than editing engine code,
// this module lets a real schedule be pasted in (JSON, or a simple CSV export)
// and converts it into the four fee-side knobs backtests already understand:
//
//   commissionMult       — the imported tariff priced against our model, over
//                          a representative ladder of ticket sizes
//   commissionFloorBase  — the per-ticket minimum for the base currency
//   stampMult            — the schedule's UK stamp rate / the statutory 0.5%
//   ptmLevy              — whether the takeover-panel levy is charged at all
//
// Deliberately tolerant: a schedule may quote percentages or bps, may omit
// venues, may spell the currency in lower case. Anything unusable is skipped
// with a warning rather than silently poisoning a run with NaN friction.
//
// Pure, deterministic and I/O-free.

import {
  estimateSaxoCommission,
  SAXO_FEE_SCHEDULE,
  type SaxoVenueTier,
} from "../saxo-fees";
import { UK_STAMP_DUTY_BPS } from "../trade-viability-gate";

export type FeeScheduleVenue = {
  /** ISO 4217 trade currency the tariff line applies to. */
  currency: string;
  /** Optional venue label, purely for the basis note. */
  venue?: string;
  /** Per-side commission as a fraction of notional (0.0008 = 8bps). */
  rate: number;
  /** Minimum per-side commission in trade currency. */
  min: number;
  /** Optional per-ticket cap; 0 or absent means uncapped. */
  cap?: number;
};

export type FeeScheduleTaxes = {
  /** UK stamp duty / SDRT as a percentage of consideration (0.5 = statutory). */
  ukStampDutyPct?: number;
  /** Charge the takeover-panel levy at all. */
  ptmLevy?: boolean;
  /** Funding-leg FX spread the broker quotes, in bps. */
  fxSpreadBps?: number;
};

export type BrokerFeeSchedule = {
  broker: string;
  /** Tariff/tier name, e.g. "Classic", "Platinum". */
  tier?: string;
  /** When the schedule was published or captured (ISO date). */
  asOf?: string;
  /** Currency the account is denominated in. Drives `commissionFloorBase`. */
  baseCurrency: string;
  venues: FeeScheduleVenue[];
  taxes?: FeeScheduleTaxes;
};

export type FeeScheduleParse = {
  schedule: BrokerFeeSchedule | null;
  warnings: string[];
};

const isFin = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const num = (v: unknown): number | null => {
  if (isFin(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[£$€%,\s]/g, "");
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/**
 * Normalise a quoted commission rate to a fraction of notional. Brokers quote
 * the same tariff three ways — 0.0008, "0.08%" and "8bps" all mean the same
 * thing — so infer from the field name and magnitude rather than trusting one
 * convention.
 */
function normaliseRate(raw: Record<string, unknown>): number | null {
  const bps = num(raw["rateBps"] ?? raw["bps"] ?? raw["commissionBps"]);
  if (bps !== null) return bps / 10_000;
  const pct = num(raw["ratePct"] ?? raw["percent"] ?? raw["commissionPct"]);
  if (pct !== null) return pct / 100;
  const rate = num(raw["rate"] ?? raw["commission"]);
  if (rate === null) return null;
  // A bare `rate` above 0.05 (5% per side) is certainly a percentage.
  return rate > 0.05 ? rate / 100 : rate;
}

function parseVenueRow(
  raw: Record<string, unknown>,
  warnings: string[],
  index: number,
): FeeScheduleVenue | null {
  const ccy = String(raw["currency"] ?? raw["ccy"] ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(ccy)) {
    warnings.push(`venue row ${index + 1}: missing or invalid currency — skipped`);
    return null;
  }
  const rate = normaliseRate(raw);
  if (rate === null || rate < 0 || rate > 0.05) {
    warnings.push(`${ccy}: commission rate missing or out of range — skipped`);
    return null;
  }
  const min = num(raw["min"] ?? raw["minimum"] ?? raw["minCommission"]) ?? 0;
  const cap = num(raw["cap"] ?? raw["maximum"]) ?? 0;
  return {
    currency: ccy,
    venue: typeof raw["venue"] === "string" ? raw["venue"] : undefined,
    rate,
    min: Math.max(0, min),
    ...(cap > 0 ? { cap } : {}),
  };
}

function parseCsv(text: string, warnings: string[]): Record<string, unknown>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length < 2) {
    warnings.push("CSV needs a header row and at least one venue row");
    return [];
  }
  const header = lines[0]!.split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, unknown> = {};
    header.forEach((h, i) => {
      row[h] = cells[i]?.trim();
    });
    return row;
  });
}

/**
 * Parse a pasted fee schedule. Accepts a JSON string, an already-parsed
 * object, or a CSV export with a `currency,rate,min` style header.
 */
export function parseFeeSchedule(input: unknown): FeeScheduleParse {
  const warnings: string[] = [];
  let obj: unknown = input;

  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return { schedule: null, warnings: ["empty schedule"] };
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        obj = JSON.parse(text);
      } catch {
        return { schedule: null, warnings: ["schedule is not valid JSON"] };
      }
    } else {
      obj = { venues: parseCsv(text, warnings) };
    }
  }

  if (Array.isArray(obj)) obj = { venues: obj };
  if (!obj || typeof obj !== "object") {
    return { schedule: null, warnings: [...warnings, "schedule must be an object or array"] };
  }
  const root = obj as Record<string, unknown>;
  const rawVenues = Array.isArray(root["venues"]) ? (root["venues"] as unknown[]) : [];
  const venues: FeeScheduleVenue[] = [];
  rawVenues.forEach((v, i) => {
    if (!v || typeof v !== "object") {
      warnings.push(`venue row ${i + 1}: not an object — skipped`);
      return;
    }
    const parsed = parseVenueRow(v as Record<string, unknown>, warnings, i);
    if (parsed) venues.push(parsed);
  });

  if (venues.length === 0) {
    return { schedule: null, warnings: [...warnings, "no usable venue rows"] };
  }

  const rawTaxes = (root["taxes"] ?? {}) as Record<string, unknown>;
  const stampPct = num(rawTaxes["ukStampDutyPct"] ?? rawTaxes["stampDutyPct"]);
  const fxBps = num(rawTaxes["fxSpreadBps"] ?? root["fxSpreadBps"]);
  const taxes: FeeScheduleTaxes = {};
  if (stampPct !== null && stampPct >= 0 && stampPct <= 5) taxes.ukStampDutyPct = stampPct;
  else if (stampPct !== null) warnings.push("stamp duty percentage out of range — ignored");
  if (typeof rawTaxes["ptmLevy"] === "boolean") taxes.ptmLevy = rawTaxes["ptmLevy"];
  if (fxBps !== null && fxBps >= 0 && fxBps <= 200) taxes.fxSpreadBps = fxBps;

  const baseCurrency = String(root["baseCurrency"] ?? "GBP").toUpperCase();

  return {
    schedule: {
      broker: String(root["broker"] ?? "imported"),
      tier: typeof root["tier"] === "string" ? root["tier"] : undefined,
      asOf: typeof root["asOf"] === "string" ? root["asOf"] : undefined,
      baseCurrency: /^[A-Z]{3}$/.test(baseCurrency) ? baseCurrency : "GBP",
      venues,
      ...(Object.keys(taxes).length ? { taxes } : {}),
    },
    warnings,
  };
}

/** Ticket sizes (in trade currency) used to price a tariff against our model. */
export const CALIBRATION_TICKETS = [250, 500, 1_000, 2_500, 5_000] as const;

export type FeeScheduleDefaults = {
  commissionMult: number;
  commissionFloorBase: number | null;
  stampMult: number;
  ptmLevy: boolean;
  fxSpreadBps: number | null;
  /** Currencies whose commission the comparison actually covered. */
  currencies: string[];
  /** Model vs schedule totals over the ticket ladder, for the basis note. */
  scheduleCost: number;
  modelCost: number;
  note: string;
};

function priceUnder(tier: SaxoVenueTier | FeeScheduleVenue, notional: number): number {
  let c = Math.max(tier.min, notional * tier.rate);
  if (tier.cap && tier.cap > 0) c = Math.min(c, tier.cap);
  return c;
}

/**
 * Convert a parsed schedule into assumption defaults.
 *
 * `commissionMult` is the ratio of what the imported tariff charges to what
 * our built-in model charges over a ladder of realistic ticket sizes across
 * every currency the schedule covers — so a broker that is cheaper on big
 * tickets but harsher on small ones lands somewhere honest in between rather
 * than being judged on one lucky size.
 */
export function feeScheduleDefaults(
  schedule: BrokerFeeSchedule,
  tickets: readonly number[] = CALIBRATION_TICKETS,
): FeeScheduleDefaults {
  const sizes = tickets.filter((t) => isFin(t) && t > 0);
  const ladder = sizes.length ? sizes : [...CALIBRATION_TICKETS];
  let scheduleCost = 0;
  let modelCost = 0;
  const currencies: string[] = [];

  for (const venue of schedule.venues) {
    currencies.push(venue.currency);
    for (const notional of ladder) {
      scheduleCost += priceUnder(venue, notional);
      const model = SAXO_FEE_SCHEDULE[venue.currency]
        ? estimateSaxoCommission({ notional, currency: venue.currency }).commission
        : priceUnder(SAXO_FEE_SCHEDULE["USD"]!, notional);
      modelCost += model;
    }
  }

  const rawMult = modelCost > 0 ? scheduleCost / modelCost : 1;
  const commissionMult = Math.round(Math.min(3, Math.max(0, rawMult)) * 100) / 100;

  const baseVenue =
    schedule.venues.find((v) => v.currency === schedule.baseCurrency) ?? null;
  const commissionFloorBase = baseVenue ? baseVenue.min : null;

  const stampPct = schedule.taxes?.ukStampDutyPct;
  const stampMult =
    stampPct === undefined
      ? 1
      : Math.round(((stampPct * 100) / UK_STAMP_DUTY_BPS) * 100) / 100;

  return {
    commissionMult,
    commissionFloorBase,
    stampMult,
    ptmLevy: schedule.taxes?.ptmLevy ?? true,
    fxSpreadBps: schedule.taxes?.fxSpreadBps ?? null,
    currencies: [...new Set(currencies)],
    scheduleCost: Math.round(scheduleCost * 100) / 100,
    modelCost: Math.round(modelCost * 100) / 100,
    note:
      `${schedule.broker}${schedule.tier ? ` ${schedule.tier}` : ""}` +
      `${schedule.asOf ? ` (as of ${schedule.asOf})` : ""}: ` +
      `${schedule.venues.length} venues priced over ${ladder.length} ticket sizes — ` +
      `schedule ${scheduleCost.toFixed(0)} vs model ${modelCost.toFixed(0)}` +
      (commissionFloorBase !== null
        ? `, ${schedule.baseCurrency} floor ${commissionFloorBase}`
        : "") +
      (stampPct !== undefined ? `, stamp ${stampPct}%` : ""),
  };
}

/** One-shot: raw paste → defaults, with the parse warnings carried through. */
export function importFeeSchedule(
  input: unknown,
  tickets?: readonly number[],
): { defaults: FeeScheduleDefaults | null; schedule: BrokerFeeSchedule | null; warnings: string[] } {
  const { schedule, warnings } = parseFeeSchedule(input);
  if (!schedule) return { defaults: null, schedule: null, warnings };
  return { defaults: feeScheduleDefaults(schedule, tickets), schedule, warnings };
}
