/**
 * Learned broker instrument blocks.
 *
 * Some broker rejections are *permanent for this account* rather than
 * transient: the classic one on Saxo is
 *
 *   "The order has been rejected because the instrument is not currently
 *    suitable for you or because a suitability test has not been taken."
 *
 * That fires for complex products (ETCs/ETNs such as SGLN.L, leveraged
 * products, derivatives) when the account has not completed Saxo's
 * appropriateness/suitability questionnaire for that product category.
 * Retrying next hour will fail identically and burns a broker order slot,
 * so we learn the block and drop the symbol from the live universe until
 * the user clears it (by taking the test at the broker and un-blocking).
 *
 * This module is pure classification so it can be unit-tested without a DB.
 */

export type BrokerBlockReason =
  | "suitability" // appropriateness/suitability test not taken
  | "not_tradable" // instrument not tradable on this account type
  | "not_permitted" // account lacks permission for this product
  | "kid_unavailable"; // no PRIIPs Key Information Document for retail clients

export type BrokerBlockClassification = {
  block: boolean;
  reason: BrokerBlockReason | null;
  /** Human-readable, safe to show in the UI. */
  detail: string | null;
};

const SUITABILITY_PATTERNS = [
  /not currently suitable for you/i,
  /suitability test has not been taken/i,
  /appropriateness test/i,
  /knowledge and experience/i,
];

const NOT_TRADABLE_PATTERNS = [
  /instrument is not tradable/i,
  /not tradable on this account/i,
  /trading in this instrument is not allowed/i,
];

// PRIIPs: EU/UK retail clients cannot buy a fund with no Key Information
// Document (classic case: US-domiciled ETFs such as SPY). This never clears by
// retrying — the document simply does not exist for that share class.
const KID_PATTERNS = [
  /key information document/i,
  /\bKID\b.*not available/i,
  /not available.*\bKID\b/i,
  /cannot trade this instrument as a retail client/i,
  /\bPRIIPs?\b/i,
];

const KID_CODES = new Set([
  "kidnotavailable",
  "kiidnotavailable",
  "priipskidmissing",
]);

const NOT_PERMITTED_PATTERNS = [
  /not permitted to trade/i,
  /no trading permission/i,
  /account is not enabled for/i,
];

const SUITABILITY_CODES = new Set([
  "suitabilitycheckfailed",
  "instrumentnotsuitable",
  "appropriatenesscheckfailed",
]);

const NOT_TRADABLE_CODES = new Set([
  "instrumentnottradable",
  "instrumentnottradeable",
]);

const NOT_PERMITTED_CODES = new Set([
  "tradingnotallowed",
  "notradingpermission",
]);

/**
 * Decide whether a broker rejection means "never retry this symbol on this
 * account until a human intervenes".
 */
export function classifyBrokerBlock(
  rejectReason: string | null | undefined,
  errorCode?: string | null,
): BrokerBlockClassification {
  const code = (errorCode ?? "").trim().toLowerCase();
  if (code) {
    if (SUITABILITY_CODES.has(code)) {
      return {
        block: true,
        reason: "suitability",
        detail: "Broker suitability/appropriateness test not completed for this product type.",
      };
    }
    if (NOT_TRADABLE_CODES.has(code)) {
      return {
        block: true,
        reason: "not_tradable",
        detail: "Instrument is not tradable on this broker account.",
      };
    }
    if (KID_CODES.has(code)) {
      return {
        block: true,
        reason: "kid_unavailable",
        detail:
          "No Key Information Document (KID) for this instrument, so retail clients cannot buy it.",
      };
    }
    if (NOT_PERMITTED_CODES.has(code)) {
      return {
        block: true,
        reason: "not_permitted",
        detail: "Account does not have permission to trade this instrument.",
      };
    }
  }

  const text = (rejectReason ?? "").trim();
  if (!text) return { block: false, reason: null, detail: null };

  if (SUITABILITY_PATTERNS.some((re) => re.test(text))) {
    return {
      block: true,
      reason: "suitability",
      detail: "Broker suitability/appropriateness test not completed for this product type.",
    };
  }
  if (KID_PATTERNS.some((re) => re.test(text))) {
    return {
      block: true,
      reason: "kid_unavailable",
      detail:
        "No Key Information Document (KID) for this instrument, so retail clients cannot buy it.",
    };
  }
  if (NOT_TRADABLE_PATTERNS.some((re) => re.test(text))) {
    return {
      block: true,
      reason: "not_tradable",
      detail: "Instrument is not tradable on this broker account.",
    };
  }
  if (NOT_PERMITTED_PATTERNS.some((re) => re.test(text))) {
    return {
      block: true,
      reason: "not_permitted",
      detail: "Account does not have permission to trade this instrument.",
    };
  }

  return { block: false, reason: null, detail: null };
}

/**
 * Symbol spellings differ between the engine universe ("SGLN.L") and the
 * broker ("SGLN:xlon"). Blocks are stored on a normalised root so either
 * spelling matches.
 */
export function blockSymbolKey(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const root = s.split(":")[0].replace(/\.[A-Z]+$/, "");
  return root;
}

/** True when `symbol` is covered by any of the stored blocked keys. */
export function isSymbolBlocked(symbol: string, blockedKeys: Iterable<string>): boolean {
  const key = blockSymbolKey(symbol);
  for (const b of blockedKeys) {
    if (blockSymbolKey(b) === key) return true;
  }
  return false;
}

/**
 * One-line "what to do next" for a block reason. Shared by the notification
 * body, the audit log row, and the dashboard panel so all three agree.
 */
export function recommendedActionFor(reason: BrokerBlockReason | string): string {
  switch (reason) {
    case "suitability":
      return "Complete Saxo's appropriateness/suitability test for this product category (Account → Profile → Investor profile), then clear the block in Blocked instruments.";
    case "not_tradable":
      return "Check the instrument is available for your Saxo account type and that you hold the required exchange/market-data subscription, then clear the block.";
    case "kid_unavailable":
      return "This instrument has no Key Information Document, so it cannot be bought by a retail client — use a UCITS equivalent (e.g. VUSA/CSPX instead of SPY). Only clear the block if Saxo confirms a KID is now published.";
    case "not_permitted":
      return "Request the missing trading permission for this product in your Saxo account, then clear the block once approved.";
    default:
      return "Contact Saxo support to confirm why this instrument is restricted, then clear the block.";
  }
}
