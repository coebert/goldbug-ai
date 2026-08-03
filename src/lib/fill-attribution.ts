// Guard against "combined broker position" sell fills.
//
// Two sim portfolios can share one Saxo account. When the engine sized a SELL
// against the *account-level* position instead of the portfolio's own book, the
// whole fill landed on one portfolio and the fills ledger replayed to a phantom
// short (e.g. SGLN.L −447, V −584 on "High risk sim portfolio").
//
// Every sell fill must be attributed against positions the portfolio actually
// holds. This module is pure so the reconciler, backfills and tests share one
// rule.

export type LedgerPosition = { portfolioId: string; quantity: number };

export type AttributedLeg = { portfolioId: string; quantity: number };

export type SellAttribution = {
  /** Per-portfolio legs, largest holder first. Never exceeds held quantity. */
  legs: AttributedLeg[];
  /** Quantity the broker reported that no portfolio could have held. */
  unattributed: number;
};

/**
 * Split a broker sell fill across the portfolios sharing the broker account.
 *
 * - The portfolio the order was placed from is filled first (up to what it
 *   holds), then siblings in descending position size.
 * - No leg ever exceeds the portfolio's held quantity, so a replay of the
 *   ledger can never go short.
 * - Anything left over is reported as `unattributed` rather than silently
 *   dumped onto a portfolio.
 */
export function attributeSellFill(input: {
  quantity: number;
  orderPortfolioId: string;
  positions: LedgerPosition[];
}): SellAttribution {
  const total = Number(input.quantity) || 0;
  if (!(total > 0)) return { legs: [], unattributed: 0 };

  const held = input.positions
    .map((p) => ({ portfolioId: p.portfolioId, quantity: Math.max(0, Number(p.quantity) || 0) }))
    .filter((p) => p.quantity > 0);

  const ordered = [...held].sort((a, b) => {
    if (a.portfolioId === input.orderPortfolioId) return -1;
    if (b.portfolioId === input.orderPortfolioId) return 1;
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    return a.portfolioId.localeCompare(b.portfolioId);
  });

  const legs: AttributedLeg[] = [];
  let remaining = total;
  for (const p of ordered) {
    if (remaining <= 0) break;
    const qty = Math.min(p.quantity, remaining);
    if (qty <= 0) continue;
    legs.push({ portfolioId: p.portfolioId, quantity: qty });
    remaining -= qty;
  }

  return { legs, unattributed: Math.max(0, remaining) };
}

/** True when the fill as recorded would push the portfolio's book negative. */
export function isOversizedSell(quantity: number, heldQuantity: number): boolean {
  return (Number(quantity) || 0) > (Number(heldQuantity) || 0) + 1e-9;
}
