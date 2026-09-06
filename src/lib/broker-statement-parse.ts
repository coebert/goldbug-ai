/**
 * Parse a broker booking/charge statement (CSV, TSV or semicolon export) into
 * the same `BrokerTradeCharge` shape the live cost report produces.
 *
 * Why this exists: Saxo's API cost report answers for this account but carries
 * no money on it, so every fill stays on modelled fees. The downloadable
 * booking statement *does* carry the invoiced amounts. Parsing it here lets the
 * existing matcher, FX conversion and pence/pound unit gate run unchanged —
 * the importer is just another source of charges, not a second cost pipeline.
 *
 * Pure: text in, charges out. No I/O, so it is fully unit-testable.
 */

import type { BrokerTradeCharge } from "./brokers/adapter";

export type StatementParseIssue = { line: number; reason: string };

export type StatementParseResult = {
  charges: BrokerTradeCharge[];
  /** Header cells exactly as they appeared, for operator diagnostics. */
  columns: string[];
  /** Header cells we could not map to any known field. */
  unmappedColumns: string[];
  /** Data rows read, excluding the header. */
  rowsRead: number;
  skipped: StatementParseIssue[];
  /** Sum of every parsed charge total, per stated currency. */
  totalsByCurrency: Record<string, number>;
  delimiter: string;
};

const FIELD_ALIASES: Record<string, readonly string[]> = {
  tradeId: ["tradeid", "trade id", "tradenumber", "trade no", "transactionid", "transaction id", "bookingid", "booking id", "dealid", "deal id", "id"],
  orderId: ["orderid", "order id", "brokerorderid", "order number", "order no"],
  clientRef: ["externalreference", "external reference", "clientreference", "client reference", "clientorderid", "client order id", "reference"],
  symbol: ["symbol", "instrument", "instrumentsymbol", "ticker", "instrument symbol", "product", "security"],
  side: ["side", "buysell", "buy/sell", "b/s", "direction", "action", "tradetype", "trade type"],
  quantity: ["quantity", "qty", "filledquantity", "filled quantity", "amount", "units", "shares", "nominal"],
  price: ["price", "tradeprice", "trade price", "averageprice", "average price", "fillprice", "fill price"],
  tradedAt: ["tradedate", "trade date", "date", "executiontime", "execution time", "tradetime", "trade time", "bookingdate", "booking date", "timestamp", "valuedate", "value date"],
  currency: ["currency", "ccy", "chargecurrency", "charge currency", "tradecurrency", "trade currency", "costcurrency", "cost currency"],
  commission: ["commission", "commissions", "brokerage", "brokeragefee", "commission amount", "tradecommission", "trade commission"],
  exchangeFee: ["exchangefee", "exchange fee", "exchange", "clearingfee", "clearing fee", "regulatoryfee", "regulatory fee", "levy", "ptmlevy", "ptm levy", "exchangefees"],
  tax: ["tax", "taxes", "stampduty", "stamp duty", "stamp", "transactiontax", "transaction tax", "financialtransactiontax", "sdrt"],
  other: ["other", "othercharges", "other charges", "custody", "custodyfee", "conversionfee", "conversion fee", "fxmarkup", "fx markup", "financing", "miscellaneous", "misc"],
  total: ["total", "totalcost", "total cost", "totalcharges", "total charges", "totalfees", "total fees", "costs", "charges", "totalamount"],
};

const CANON = new Map<string, string>();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  for (const a of aliases) CANON.set(a.replace(/[^a-z0-9]/g, ""), field);
}

function detectDelimiter(line: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const n = splitLine(line, d).length;
    if (n > bestCount) {
      bestCount = n;
      best = d;
    }
  }
  return best;
}

/** RFC4180-ish split: honours double quotes and doubled escapes. */
export function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** `-£1,234.56`, `(12.30)`, `12,30` and `USD 4.10` all become a positive 1234.56 / 12.3 / 4.1. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.trim().startsWith("-");
  s = s.replace(/[()]/g, "").replace(/[^0-9.,-]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // European format: dots group thousands, comma is the decimal point.
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s.replace(/-/g, ""));
  if (!Number.isFinite(n)) return null;
  // Charges are money paid; sign conventions differ per export, so magnitude wins.
  return negative ? Math.abs(n) : n;
}

function parseSide(raw: string | undefined, quantity: number | null): "buy" | "sell" | undefined {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/^(b|buy|bought|bot|purchase|long)/.test(s)) return "buy";
  if (/^(s|sell|sold|sld|sale|short)/.test(s)) return "sell";
  if (quantity != null && quantity < 0) return "sell";
  if (quantity != null && quantity > 0) return "buy";
  return undefined;
}

function parseDate(raw: string | undefined): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  // dd/mm/yyyy and dd-mm-yyyy, optionally with a time — the common UK export.
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, d, mo, y, hh, mm, ss] = m;
    const iso = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(hh ?? 0),
      Number(mm ?? 0),
      Number(ss ?? 0),
    );
    if (Number.isFinite(iso)) return new Date(iso).toISOString();
  }
  return undefined;
}

function normaliseCurrency(raw: string | undefined, fallback: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  // Case is meaningful: `GBp` is pence, `GBP` is pounds. Keep it verbatim when
  // it already looks like a code, so the downstream unit gate can see it.
  const m = s.match(/[A-Za-z]{3}/);
  return m ? m[0] : fallback;
}

export function parseBrokerStatement(
  text: string,
  opts?: { defaultCurrency?: string },
): StatementParseResult {
  const fallbackCcy = opts?.defaultCurrency ?? "GBP";
  const lines = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  const empty: StatementParseResult = {
    charges: [],
    columns: [],
    unmappedColumns: [],
    rowsRead: 0,
    skipped: [],
    totalsByCurrency: {},
    delimiter: ",",
  };
  if (lines.length < 2) {
    return { ...empty, skipped: [{ line: 0, reason: "statement has no data rows" }] };
  }

  const delimiter = detectDelimiter(lines[0] ?? "");
  const columns = splitLine(lines[0] ?? "", delimiter);
  const fieldByIndex = new Map<number, string>();
  const unmappedColumns: string[] = [];
  columns.forEach((c, i) => {
    const field = CANON.get(c.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (field && ![...fieldByIndex.values()].includes(field)) fieldByIndex.set(i, field);
    else if (!field) unmappedColumns.push(c);
  });

  const hasMoney = [...fieldByIndex.values()].some((f) =>
    ["commission", "exchangeFee", "tax", "other", "total"].includes(f),
  );
  if (!hasMoney) {
    return {
      ...empty,
      columns,
      unmappedColumns,
      delimiter,
      skipped: [
        {
          line: 1,
          reason:
            "no charge column found — the file needs at least one of commission, tax, exchange fee or total cost",
        },
      ],
    };
  }

  const charges: BrokerTradeCharge[] = [];
  const skipped: StatementParseIssue[] = [];
  const totalsByCurrency: Record<string, number> = {};
  let rowsRead = 0;

  for (let li = 1; li < lines.length; li += 1) {
    const cells = splitLine(lines[li] ?? "", delimiter);
    if (cells.every((c) => c === "")) continue;
    rowsRead += 1;

    const get = (field: string): string | undefined => {
      for (const [i, f] of fieldByIndex) if (f === field) return cells[i];
      return undefined;
    };

    const commission = parseAmount(get("commission")) ?? 0;
    const exchangeFee = parseAmount(get("exchangeFee")) ?? 0;
    const tax = parseAmount(get("tax")) ?? 0;
    const other = parseAmount(get("other")) ?? 0;
    const declared = parseAmount(get("total"));
    const itemised = commission + exchangeFee + tax + other;
    const total = declared != null && declared > itemised ? declared : itemised;

    if (!(total > 0)) {
      skipped.push({ line: li + 1, reason: "row carries no charge amount" });
      continue;
    }

    const quantityRaw = parseAmount(get("quantity"));
    const sideRaw = get("side");
    const side = parseSide(sideRaw, quantityRaw != null && /-/.test(String(get("quantity"))) ? -quantityRaw : quantityRaw);
    const tradedAt = parseDate(get("tradedAt"));
    const symbol = (get("symbol") ?? "").trim();
    const currency = normaliseCurrency(get("currency"), fallbackCcy);
    const tradeId =
      (get("tradeId") ?? "").trim() ||
      // No broker id: build a stable synthetic key so a re-import of the same
      // statement overwrites its own rows instead of double-booking them.
      `stmt:${symbol || "?"}:${(tradedAt ?? "").slice(0, 10)}:${side ?? "?"}:${quantityRaw ?? 0}:${total.toFixed(2)}`;

    const charge: BrokerTradeCharge = {
      brokerTradeId: tradeId,
      currency,
      commission,
      exchangeFee,
      tax,
      other,
      total,
      raw: { line: li + 1, cells },
    };
    const orderId = (get("orderId") ?? "").trim();
    if (orderId) charge.brokerOrderId = orderId;
    const ref = (get("clientRef") ?? "").trim();
    if (ref) charge.clientOrderId = ref;
    if (symbol) charge.symbol = symbol;
    if (side) charge.side = side;
    if (quantityRaw != null && quantityRaw > 0) charge.quantity = quantityRaw;
    const price = parseAmount(get("price"));
    if (price != null && price > 0) charge.price = price;
    if (tradedAt) charge.tradedAt = tradedAt;

    charges.push(charge);
    totalsByCurrency[currency] = (totalsByCurrency[currency] ?? 0) + total;
  }

  return { charges, columns, unmappedColumns, rowsRead, skipped, totalsByCurrency, delimiter };
}

/** Oldest trade date in the parsed charges, for sizing the fill lookback window. */
export function earliestChargeDate(charges: readonly BrokerTradeCharge[]): string | null {
  let best: number | null = null;
  for (const c of charges) {
    if (!c.tradedAt) continue;
    const t = Date.parse(c.tradedAt);
    if (Number.isFinite(t) && (best == null || t < best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}
