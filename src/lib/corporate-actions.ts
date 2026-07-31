// Corporate actions — pure normalisation of Saxo's /ca event payloads.
//
// Read-only by design: Aegis never submits an election. Saxo's corporate
// action feed is loosely typed and field names vary between event types
// (and between the v1/v2 shapes), so every read here is defensive: unknown
// fields degrade to null rather than throwing, and the raw row is preserved
// so the UI can always fall back to "check Saxo".

/** What the option pays out in: cash, new shares, or a mix. */
export type OptionKind = "cash" | "securities" | "mixed" | "unknown";

export type CorporateActionOption = {
  /** Saxo's option number / id, when present. */
  id: string | null;
  /** Human label, e.g. "Cash dividend" or "Reinvest in shares". */
  label: string;
  /** True when Saxo applies this option if the client does not instruct. */
  isDefault: boolean;
  /** Free-text detail (rate, ratio, currency) when Saxo supplies it. */
  detail: string | null;
  /** Cash/scrip classification, inferred from the option label and type. */
  kind: OptionKind;
  /** Per-share cash rate, when Saxo publishes one. */
  rate: number | null;
  /** Currency of `rate`. */
  currency: string | null;
  /** New shares per held share (0.02 = 1 new share per 50 held), when known. */
  ratio: number | null;
};

export type CorporateAction = {
  id: string;
  /** Event type as reported, e.g. "DividendReinvestment". */
  eventType: string;
  /** Readable event type ("Dividend reinvestment"). */
  eventTypeLabel: string;
  /** Instrument description, e.g. "Unilever PLC". */
  instrument: string | null;
  symbol: string | null;
  uic: number | null;
  accountKey: string | null;
  /** ISO dates (or null when Saxo has not published them yet). */
  exDate: string | null;
  payDate: string | null;
  /** Election deadline — the date that actually matters. */
  deadline: string | null;
  status: string | null;
  /** True when the event needs a client instruction. */
  requiresElection: boolean;
  options: CorporateActionOption[];
  raw: Record<string, unknown>;
};

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function num(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const n = Number(source[k]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function bool(source: Record<string, unknown>, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const s = v.toLowerCase();
      if (s === "true" || s === "yes") return true;
      if (s === "false" || s === "no") return false;
    }
  }
  return false;
}

function arr(source: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const k of keys) {
    const v = source[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** "DividendReinvestment" → "Dividend reinvestment". */
export function humanizeEventType(raw: string): string {
  const spaced = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return "Corporate action";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Normalise an ISO-ish date string; returns null when unparseable. */
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const SECURITY_WORDS =
  /(scrip|reinvest|stock|share|securit|drip|new ordinar|subscri|rights)/i;
const CASH_WORDS = /(cash|proceeds|payment|dividend in cash|sell)/i;

/** Classify an option's payout from its label/type text. */
export function classifyOptionKind(text: string): OptionKind {
  const sec = SECURITY_WORDS.test(text);
  const cash = CASH_WORDS.test(text);
  if (sec && cash) return "mixed";
  if (sec) return "securities";
  if (cash) return "cash";
  return "unknown";
}

/**
 * Parse a ratio expressed as "1:20", "1 for 20", "0.05" or "1/20" into
 * new-shares-per-held-share. Returns null when unparseable.
 */
export function parseRatio(value: string | null): number | null {
  if (!value) return null;
  const pair = value.match(/(\d+(?:\.\d+)?)\s*(?::|\/|for|per)\s*(\d+(?:\.\d+)?)/i);
  if (pair) {
    const a = Number(pair[1]);
    const b = Number(pair[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b;
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeOption(input: unknown, index: number): CorporateActionOption {
  const o = rec(input);
  const label =
    str(o, "OptionName", "Name", "Description", "OptionDescription", "OptionType", "Type") ??
    `Option ${index + 1}`;
  const detailBits: string[] = [];
  const rate = num(o, "Rate", "GrossAmount", "NetAmount", "Amount", "Price");
  const ccy = str(o, "CurrencyCode", "Currency");
  if (rate != null) detailBits.push(ccy ? `${rate} ${ccy}` : String(rate));
  const ratio = str(o, "Ratio", "RatioNew", "TermsRatio");
  if (ratio) detailBits.push(`ratio ${ratio}`);
  const kindText = [label, str(o, "OptionType", "Type", "InstructionType") ?? ""].join(" ");
  return {
    id: str(o, "OptionNumber", "OptionId", "Id", "Number"),
    label,
    isDefault: bool(o, "IsDefault", "Default", "IsDefaultOption"),
    detail: detailBits.length ? detailBits.join(" · ") : null,
    kind: classifyOptionKind(kindText),
    rate,
    currency: ccy,
    ratio: parseRatio(ratio) ?? num(o, "RatioFactor", "SharesPerShare"),
  };
}

/**
 * Turn a raw Saxo corporate-actions payload row into a `CorporateAction`.
 * Never throws: anything unrecognised degrades to null/empty.
 */
export function normalizeCorporateAction(input: unknown, index = 0): CorporateAction {
  const e = rec(input);
  const display = rec(e.DisplayAndFormat);
  const eventType =
    str(e, "EventType", "CorporateActionType", "Type", "SubEventType") ?? "CorporateAction";
  const options = arr(
    e,
    "ElectiveOptions",
    "Options",
    "EventOptions",
    "CorporateActionOptions",
  ).map(normalizeOption);
  const deadline =
    normalizeDate(e.ResponseDeadline) ??
    normalizeDate(e.ElectionDeadline) ??
    normalizeDate(e.DeadlineDate) ??
    normalizeDate(e.ClientDeadline) ??
    normalizeDate(e.ReplyDeadline);
  return {
    id:
      str(e, "EventId", "CorporateActionId", "Id", "ExternalReference") ??
      `ca-${index}`,
    eventType,
    eventTypeLabel: humanizeEventType(eventType),
    instrument:
      str(display, "Description", "Symbol") ??
      str(e, "InstrumentDescription", "Description", "InstrumentName"),
    symbol: str(display, "Symbol") ?? str(e, "Symbol", "InstrumentSymbol"),
    uic: num(e, "Uic", "InstrumentUic"),
    accountKey: str(e, "AccountKey"),
    exDate: normalizeDate(e.ExDate) ?? normalizeDate(e.ExDividendDate),
    payDate: normalizeDate(e.PayDate) ?? normalizeDate(e.PaymentDate),
    deadline,
    status: str(e, "Status", "EventStatus", "InstructionStatus"),
    requiresElection: options.length > 1,
    options,
    raw: e,
  };
}

export function normalizeCorporateActions(rows: unknown): CorporateAction[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r, i) => normalizeCorporateAction(r, i));
}

/**
 * Sort soonest-deadline first; events without a deadline sink to the bottom
 * (they are informational until Saxo publishes one).
 */
export function sortByDeadline(events: CorporateAction[]): CorporateAction[] {
  return [...events].sort((a, b) => {
    const at = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
    const bt = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return (a.instrument ?? a.id).localeCompare(b.instrument ?? b.id);
  });
}

export type DeadlineUrgency = "passed" | "urgent" | "soon" | "later" | "unknown";

/** Whole days until the deadline; negative once it has passed. */
export function daysUntil(deadline: string | null, now: Date = new Date()): number | null {
  if (!deadline) return null;
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / 86_400_000);
}

export function deadlineUrgency(
  deadline: string | null,
  now: Date = new Date(),
): DeadlineUrgency {
  const d = daysUntil(deadline, now);
  if (d == null) return "unknown";
  if (d < 0) return "passed";
  if (d <= 3) return "urgent";
  if (d <= 14) return "soon";
  return "later";
}
