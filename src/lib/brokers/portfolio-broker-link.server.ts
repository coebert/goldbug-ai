// Which broker account a portfolio is actually linked to.
//
// BUG THIS EXISTS TO PREVENT: `buildSaxoAdapter` previously resolved the
// account key purely from `process.env.SAXO_ACCOUNT_KEY` (or, failing that,
// the first tradable account on the token). Every portfolio in the same
// environment therefore read and wrote the SAME Saxo account, so two
// different sim portfolios (e.g. "High risk sim" and "Balanced risk sim")
// were both overwritten with one account's cash and positions and rendered
// byte-identical holdings and equity.
//
// Two rules follow, and both are enforced here:
//   1. A portfolio is only broker-backed when it stores `broker = 'saxo'`
//      AND a `broker_account_id`. Anything else is a locally-simulated
//      portfolio whose ledger must never be replaced by broker state.
//   2. Broker calls made on behalf of a portfolio must be scoped to that
//      portfolio's own account key — never the process-wide default.

export type PortfolioBrokerRow = {
  broker?: string | null;
  broker_account_id?: string | null;
};

export type BrokerLink =
  | { linked: true; accountKey: string }
  | { linked: false; reason: string };

/**
 * Resolve the broker account a portfolio is bound to.
 * Returns `linked: false` (with a human reason for the skip log) when the
 * portfolio is not bound to a specific broker account.
 */
export function resolvePortfolioBrokerLink(p: PortfolioBrokerRow): BrokerLink {
  const broker = (p.broker ?? "").trim().toLowerCase();
  const accountKey = (p.broker_account_id ?? "").trim();
  if (!broker) {
    return { linked: false, reason: "portfolio is not linked to a broker (simulated ledger)" };
  }
  if (broker !== "saxo") {
    return { linked: false, reason: `unsupported broker "${broker}"` };
  }
  if (!accountKey) {
    return {
      linked: false,
      reason: "portfolio has no broker_account_id — refusing to fall back to the default account",
    };
  }
  return { linked: true, accountKey };
}

/** True when broker state may overwrite this portfolio's local holdings/cash. */
export function isBrokerBacked(p: PortfolioBrokerRow): boolean {
  return resolvePortfolioBrokerLink(p).linked;
}
