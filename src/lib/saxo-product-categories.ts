/**
 * Maps a blocked broker instrument onto the Saxo appropriateness-test product
 * category the user needs to complete before the block can be cleared.
 *
 * Pure, presentation-only helper: it does not change trading behaviour.
 */

export type SaxoCategoryId =
  | "etc_commodities"
  | "leveraged_inverse_etf"
  | "complex_etf"
  | "derivatives"
  | "exchange_access"
  | "other";

export type SaxoCategory = {
  id: SaxoCategoryId;
  /** Short label used as the checklist item title. */
  title: string;
  /** Where in the Saxo questionnaire this section lives. */
  where: string;
};

export const SAXO_CATEGORIES: Record<SaxoCategoryId, SaxoCategory> = {
  etc_commodities: {
    id: "etc_commodities",
    title: "Commodity ETCs / ETNs",
    where: "Appropriateness test → Exchange traded commodities (ETC/ETN)",
  },
  leveraged_inverse_etf: {
    id: "leveraged_inverse_etf",
    title: "Leveraged & inverse ETFs",
    where: "Appropriateness test → Complex ETFs (leveraged / inverse)",
  },
  complex_etf: {
    id: "complex_etf",
    title: "Complex ETFs",
    where: "Appropriateness test → Exchange traded funds",
  },
  derivatives: {
    id: "derivatives",
    title: "Derivatives & margin products",
    where: "Trading permissions → Derivatives / margin products",
  },
  exchange_access: {
    id: "exchange_access",
    title: "Exchange & market data access",
    where: "Account → Subscriptions / market data",
  },
  other: {
    id: "other",
    title: "Other restricted instruments",
    where: "Contact Saxo support to confirm the restriction",
  },
};

const LEVERAGED_INVERSE = /(^|[^A-Z])(XUKS|XSPS|XS2D|SUK2|3(?:UKL|USL|LDE)|LQQ3|QQQS)/i;
const INVERSE_WORDS = /\b(short|inverse|bear|2x|3x|daily\s*-?\d)\b/i;
const ETC_SYMBOLS = /(SGLN|PHAU|SGLD|IGLN|PHAG|SSLN|PHPT|PHPD|WTI|CRUD|OILB)/i;
const ETC_WORDS = /\b(gold|silver|platinum|palladium|oil|commodit|bullion|etc|etn)\b/i;
const DERIVATIVE_WORDS = /\b(cfd|future|option|warrant|margin|turbo|certificate)\b/i;

/**
 * Classifies a blocked instrument. `reason` is the broker block reason,
 * `text` is any free-text detail (instrument name / rejection message).
 */
export function categoriseBlockedInstrument(
  symbol: string,
  reason: string,
  text?: string | null,
): SaxoCategory {
  const hay = `${symbol} ${text ?? ""}`;

  if (reason === "not_tradable") return SAXO_CATEGORIES.exchange_access;

  if (DERIVATIVE_WORDS.test(hay) || reason === "not_permitted") {
    return SAXO_CATEGORIES.derivatives;
  }
  if (LEVERAGED_INVERSE.test(hay) || INVERSE_WORDS.test(hay)) {
    return SAXO_CATEGORIES.leveraged_inverse_etf;
  }
  if (ETC_SYMBOLS.test(hay) || ETC_WORDS.test(hay)) {
    return SAXO_CATEGORIES.etc_commodities;
  }
  if (/\betf\b/i.test(hay)) return SAXO_CATEGORIES.complex_etf;

  return reason === "suitability" ? SAXO_CATEGORIES.complex_etf : SAXO_CATEGORIES.other;
}

export type SaxoChecklistItem = SaxoCategory & { symbols: string[] };

/** Groups blocked instruments into a de-duplicated, ordered checklist. */
export function buildSaxoChecklist(
  blocks: Array<{ symbol: string; reason: string; detail?: string | null }>,
): SaxoChecklistItem[] {
  const byId = new Map<SaxoCategoryId, SaxoChecklistItem>();
  for (const b of blocks) {
    const cat = categoriseBlockedInstrument(b.symbol, b.reason, b.detail);
    const existing = byId.get(cat.id);
    if (existing) {
      if (!existing.symbols.includes(b.symbol)) existing.symbols.push(b.symbol);
    } else {
      byId.set(cat.id, { ...cat, symbols: [b.symbol] });
    }
  }
  const order: SaxoCategoryId[] = [
    "etc_commodities",
    "leveraged_inverse_etf",
    "complex_etf",
    "derivatives",
    "exchange_access",
    "other",
  ];
  return order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [{ ...item, symbols: [...item.symbols].sort() }] : [];
  });
}
