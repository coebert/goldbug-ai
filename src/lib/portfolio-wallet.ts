// Read/write the per-currency cash wallet stored on `portfolios.cash_by_ccy`,
// with a back-compat bridge to the legacy scalar `current_cash` field.
//
// Rules:
// - `cash_by_ccy` is authoritative when it contains at least one currency.
// - When absent/empty, we synthesize `{ [base_ccy]: current_cash }`.
// - Writes must keep the base-currency entry in sync with `current_cash` so
//   the existing UI (which still reads the scalar) stays consistent while
//   Phase B is rolled out. Once every reader migrates, `current_cash`
//   becomes a computed alias and this shim can be removed.

export type Wallet = Record<string, number>;

export type PortfolioCashLike = {
  base_ccy?: string | null;          // convenience alias if a caller has already normalised
  currency?: string | null;          // existing column
  current_cash?: number | null;      // existing scalar
  cash_by_ccy?: Wallet | null;       // new JSONB
};

const norm = (ccy: string | null | undefined, fallback = "GBP") =>
  (ccy || fallback).toUpperCase();

export function readWallet(p: PortfolioCashLike): Wallet {
  const base = norm(p.base_ccy ?? p.currency);
  const w = p.cash_by_ccy && typeof p.cash_by_ccy === "object" ? p.cash_by_ccy : {};
  const entries = Object.entries(w).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v),
  );
  if (entries.length > 0) {
    // Ensure keys are uppercase.
    const out: Wallet = {};
    for (const [k, v] of entries) out[k.toUpperCase()] = Number(v);
    // Guarantee the base currency entry exists so Phase-B code can index safely.
    if (!(base in out)) out[base] = Number(p.current_cash ?? 0);
    return out;
  }
  return { [base]: Number(p.current_cash ?? 0) };
}

export function walletBalance(w: Wallet, ccy: string): number {
  const v = w[ccy.toUpperCase()];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function applyDelta(w: Wallet, ccy: string, delta: number): Wallet {
  const k = ccy.toUpperCase();
  const cur = walletBalance(w, k);
  const next = cur + (Number.isFinite(delta) ? delta : 0);
  return { ...w, [k]: next };
}

/**
 * Given the wallet you want to persist, return the pair of fields the caller
 * should write into `portfolios`: the new `cash_by_ccy` JSON AND the scalar
 * `current_cash` mirror (so existing readers stay accurate until they
 * migrate).
 */
export function writeWalletFields(
  w: Wallet,
  baseCcy: string,
): { cash_by_ccy: Wallet; current_cash: number } {
  const base = norm(baseCcy);
  const cash_by_ccy: Wallet = {};
  for (const [k, v] of Object.entries(w)) {
    cash_by_ccy[k.toUpperCase()] = Number(v) || 0;
  }
  return {
    cash_by_ccy,
    current_cash: walletBalance(cash_by_ccy, base),
  };
}
