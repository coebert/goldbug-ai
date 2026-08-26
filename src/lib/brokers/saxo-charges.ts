/**
 * Pure mapping of Saxo's cost/activity report rows into `BrokerTradeCharge`.
 *
 * Kept out of the adapter (and out of any server-only file) so it can be
 * exercised against real payload shapes in tests without a token.
 *
 * Saxo's reporting service groups are not consistent across environments and
 * API versions: `/cs/v1/reports/trades` names its commission column one way,
 * `/cs/v1/audit/activities` another, and SIM omits several legs entirely. So
 * this reads by *candidate key*, case-insensitively, rather than pretending a
 * single documented schema exists. Anything booked that we cannot attribute to
 * a named leg is carried in `other`, because a charge we can't classify is
 * still money that left the account.
 */

import type { BrokerTradeCharge } from "./adapter";

/** Case-insensitive lookup across a row and one level of nested objects. */
function pick(row: Record<string, unknown>, keys: readonly string[]): unknown {
  const flat = new Map<string, unknown>();
  const add = (obj: Record<string, unknown>, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (!flat.has(lk)) flat.set(lk, v);
      if (depth > 0 && v && typeof v === "object" && !Array.isArray(v)) {
        add(v as Record<string, unknown>, depth - 1);
      }
    }
  };
  add(row, 1);
  for (const k of keys) {
    const v = flat.get(k.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function num(row: Record<string, unknown>, keys: readonly string[]): number {
  const v = pick(row, keys);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Charges are debits; Saxo signs them inconsistently, so we take magnitude. */
function cost(row: Record<string, unknown>, keys: readonly string[]): number {
  return Math.abs(num(row, keys));
}

function text(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const v = pick(row, keys);
  if (v === undefined) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

const COMMISSION_KEYS = [
  "Commission",
  "Commissions",
  "TotalCommission",
  "CommissionAccountCurrency",
  "CommissionsAccountCurrency",
  "ClientCommission",
  "TradeCommission",
] as const;

const EXCHANGE_KEYS = [
  "ExchangeFee",
  "ExchangeFees",
  "ClearingFee",
  "ClearingFees",
  "RegulatoryFee",
  "ExternalFee",
  "TransactionFee",
] as const;

const TAX_KEYS = [
  "StampDuty",
  "Tax",
  "Taxes",
  "TotalTax",
  "TransactionTax",
  "FinancialTransactionTax",
  "TransactionLevy",
  "PtmLevy",
] as const;

const OTHER_KEYS = [
  "ConversionCost",
  "ConversionFee",
  "CustodyFee",
  "OtherCosts",
  "TicketFee",
] as const;

/**
 * Saxo renames its cost columns per service group and environment, so a fixed
 * candidate list silently reads every charge as zero the moment a report uses
 * a name we never guessed — which is exactly how a real BP.L buy ended up
 * booked as free. Anything that *looks* like a charge column and carries money
 * is harvested here and carried as unattributed cost; a fee we cannot classify
 * is still money that left the account.
 */
const FEE_LIKE_KEY = /(commission|fee|fees|tax|duty|levy|charge|cost)/i;
/** Money-shaped names that are emphatically not charges. */
const NOT_A_FEE_KEY =
  /(free|costbasis|costprice|costtoclose|pricecost|opencost|closecost|estimated|indicative|percent|pct|rate|decimals|type|id$|description)/i;
/** Saxo suffixes the same concept per currency; strip before judging a name. */
const CCY_SUFFIX = /(accountcurrency|clientcurrency|instrumentcurrency)$/i;

/** Every fee-like numeric on the row, keyed by lower-cased path. */
export function harvestFeeLikeAmounts(row: Record<string, unknown>): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (obj: Record<string, unknown>, depth: number, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) {
        const n = Math.abs(Number(v));
        const name = k.replace(CCY_SUFFIX, "");
        if (n > 0 && FEE_LIKE_KEY.test(name) && !NOT_A_FEE_KEY.test(name)) {
          found.set(path.toLowerCase(), n);
        }
        continue;
      }
      if (depth <= 0 || !v || typeof v !== "object") continue;
      if (Array.isArray(v)) {
        v.forEach((el, i) => {
          if (el && typeof el === "object") walk(el as Record<string, unknown>, depth - 1, `${path}[${i}]`);
        });
        continue;
      }
      walk(v as Record<string, unknown>, depth - 1, path);
    }
  };
  walk(row, 2, "");
  return found;
}

/** Broker's own "everything this trade cost you" column, when it publishes one. */
const TOTAL_KEYS = [
  "TotalCost",
  "TotalCosts",
  "TotalChargesAccountCurrency",
  "TotalCharges",
] as const;

function parseSide(row: Record<string, unknown>): "buy" | "sell" | undefined {
  const raw = (text(row, ["BuySell", "TradedSide", "Direction", "TradeType", "Side"]) ?? "").toLowerCase();
  if (!raw) {
    // Some rows only signal direction through a signed quantity.
    const q = num(row, ["Amount", "TradedAmount", "FilledAmount", "Quantity"]);
    if (q > 0) return "buy";
    if (q < 0) return "sell";
    return undefined;
  }
  if (raw.startsWith("b")) return "buy";
  if (raw.startsWith("s")) return "sell";
  return undefined;
}

function parseTradedAt(row: Record<string, unknown>): string | undefined {
  const raw = text(row, [
    "TradeExecutionTime",
    "ExecutionTimeOpen",
    "TradeTime",
    "AdjustedTradeDate",
    "TradeDate",
    "ActivityTime",
    "Date",
    "ValueDate",
  ]);
  if (!raw) return undefined;
  const t = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * Map one report row. Returns null when the row carries no usable identity —
 * a charge we cannot key is a charge we cannot apply idempotently.
 */
export function mapSaxoChargeRow(
  row: Record<string, unknown>,
  fallbackCurrency = "GBP",
): BrokerTradeCharge | null {
  const brokerTradeId = text(row, [
    "TradeId",
    "TradeExecutionId",
    "TransactionId",
    "ActivityId",
    "BookingId",
    "Id",
  ]);
  if (!brokerTradeId) return null;

  const commission = cost(row, COMMISSION_KEYS);
  const exchangeFee = cost(row, EXCHANGE_KEYS);
  const tax = cost(row, TAX_KEYS);
  let other = cost(row, OTHER_KEYS);

  // When Saxo publishes a total, trust it over our sum of the legs and carry
  // the difference as unattributed cost. Losing it would flatter the KPI.
  const reportedTotal = cost(row, TOTAL_KEYS);
  const namedSum = commission + exchangeFee + tax + other;
  if (reportedTotal > namedSum + 1e-9) other += reportedTotal - namedSum;

  // Fallback for report schemas we have not seen: only when the named columns
  // produced nothing, so a row is never double-counted. Same-concept columns
  // (Commission / CommissionAccountCurrency / TotalCommission) collapse to one
  // group and contribute their largest value once.
  if (!(commission + exchangeFee + tax + other > 0)) {
    const groups = new Map<string, number>();
    for (const [path, amount] of harvestFeeLikeAmounts(row)) {
      const leaf = (path.split(".").pop() ?? path).replace(/\[\d+\]/g, "");
      const group = leaf.replace(/(accountcurrency|clientcurrency|instrumentcurrency|sum|total|s)$/g, "");
      groups.set(group, Math.max(groups.get(group) ?? 0, amount));
    }
    for (const amount of groups.values()) other += amount;
  }

  const total = commission + exchangeFee + tax + other;

  const quantityRaw = num(row, ["Amount", "TradedAmount", "FilledAmount", "Quantity"]);
  const price = Math.abs(num(row, ["Price", "TradedPrice", "ExecutionPrice", "AveragePrice"]));

  return {
    brokerTradeId,
    ...(text(row, ["OrderId", "TradeOrderId", "RelatedOrderId"]) !== undefined
      ? { brokerOrderId: text(row, ["OrderId", "TradeOrderId", "RelatedOrderId"])! }
      : {}),
    ...(text(row, ["ExternalReference", "ClientReference", "ClientOrderReference"]) !== undefined
      ? { clientOrderId: text(row, ["ExternalReference", "ClientReference", "ClientOrderReference"])! }
      : {}),
    ...(text(row, ["InstrumentSymbol", "Symbol", "Ticker", "AssetSymbol"]) !== undefined
      ? { symbol: text(row, ["InstrumentSymbol", "Symbol", "Ticker", "AssetSymbol"])! }
      : {}),
    ...(parseSide(row) !== undefined ? { side: parseSide(row)! } : {}),
    ...(quantityRaw !== 0 ? { quantity: Math.abs(quantityRaw) } : {}),
    ...(price > 0 ? { price } : {}),
    ...(parseTradedAt(row) !== undefined ? { tradedAt: parseTradedAt(row)! } : {}),
    currency: preserveUnitCase(
      text(row, ["BookingCurrency", "TradeCurrency", "Currency", "AccountCurrency", "AmountCurrency"]) ??
        fallbackCurrency,
    ),

    commission,
    exchangeFee,
    tax,
    other,
    total,
    raw: row,
  };
}

/** Map a whole report payload, dropping rows with no identity or no charge. */
export function mapSaxoChargeRows(
  rows: readonly unknown[],
  fallbackCurrency = "GBP",
): BrokerTradeCharge[] {
  const out: BrokerTradeCharge[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const charge = mapSaxoChargeRow(r as Record<string, unknown>, fallbackCurrency);
    if (!charge) continue;
    if (seen.has(charge.brokerTradeId)) continue;
    seen.add(charge.brokerTradeId);
    out.push(charge);
  }
  return out;
}
