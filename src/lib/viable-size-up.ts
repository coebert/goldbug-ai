// Raise an under-sized buy to the fee-viable floor instead of throwing it away.
//
// Whole-share rounding and haircut stacking regularly produced tickets of
// £114-£195 against a £3 minimum commission (308-526bps round trip). Those
// were rejected outright, so the idea was lost AND the measured cost of the
// account stayed high — which raised the hurdle, which shrank the next
// ticket. This helper breaks that loop: when the idea passes on merit but the
// ticket is simply too small, buy enough shares to clear the viable floor,
// provided real limits (spendable cash, a sanity cap on the uplift) allow it.
//
// Pure: no IO, no broker, no database.

export type SizeUpInput = {
  /** Whole-share quantity currently planned. */
  quantity: number;
  /** Per-share price in the instrument's own currency. */
  price: number;
  /** Notional (same currency) at which the trade becomes fee-viable. */
  minViableNotional: number;
  /** Spendable cash in the instrument's currency. */
  spendable: number;
  /** Hard ceiling on the ticket in the instrument's currency (position cap). */
  maxNotional?: number;
  /** Never grow a ticket by more than this multiple of its original size. */
  maxUpliftMultiple?: number;
};

export type SizeUpResult = {
  /** Quantity to route. Unchanged when no uplift was possible or needed. */
  quantity: number;
  applied: boolean;
  /** Explanation for the sizing trail / broker log. */
  note: string | null;
};

const DEFAULT_MAX_UPLIFT = 4;

export function planViableSizeUp(input: SizeUpInput): SizeUpResult {
  const { quantity, price } = input;
  if (!(quantity > 0) || !(price > 0) || !Number.isFinite(input.minViableNotional)) {
    return { quantity, applied: false, note: null };
  }
  const notional = quantity * price;
  if (notional >= input.minViableNotional) {
    return { quantity, applied: false, note: null };
  }

  const targetQty = Math.ceil(input.minViableNotional / price);
  if (targetQty <= quantity) return { quantity, applied: false, note: null };

  const targetNotional = targetQty * price;
  const upliftCap = notional * (input.maxUpliftMultiple ?? DEFAULT_MAX_UPLIFT);
  const ceilings = [input.spendable, input.maxNotional ?? Infinity, upliftCap].filter((v) =>
    Number.isFinite(v),
  );
  const ceiling = Math.min(...ceilings);

  if (targetNotional > ceiling) {
    return {
      quantity,
      applied: false,
      note:
        `size-up to ${targetNotional.toFixed(2)} blocked by limit ${ceiling.toFixed(2)} ` +
        `(spendable ${input.spendable.toFixed(2)})`,
    };
  }

  return {
    quantity: targetQty,
    applied: true,
    note:
      `sized up ${quantity}→${targetQty} shares (${notional.toFixed(2)}→${targetNotional.toFixed(2)}) ` +
      `to clear the ${input.minViableNotional.toFixed(2)} fee-viable floor`,
  };
}
