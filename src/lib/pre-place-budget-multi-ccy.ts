// Phase B: per-currency affordability trimming with automatic FX
// conversion legs.
//
// Where `pre-place-budget.ts` walks a single broker-cash number,
// `trimBuysToBudgetByCurrency` walks a *wallet* — `{ GBP: ..., USD: ..., EUR: ... }`
// — and pays each buy from the wallet balance in the instrument's own quote
// currency. When the target-currency balance is short and the portfolio has
// `fx_enabled=true`, the trimmer emits a synthetic FX conversion leg that
// draws from the base currency at the captured FX rate, then funds the buy.
//
// Pure function — no broker calls, no Supabase writes. The executor is
// responsible for persisting `cash_by_ccy` and logging each `FX_LEG` /
// `BUDGET_SKIP` entry to `live_broker_log`.
//
// Contract:
//   amount_from * fx(from, to) === amount_to
//   fx(x, x) === 1
//   fx must return null when the pair cannot be resolved (both providers down,
//   no cached rate). A returned rate <= 0 / non-finite is treated the same as
//   null so identity-fallback (`rate: 1`) callers should signal via a
//   dedicated marker — never dress a fabricated rate up as a real one.

export type MultiCcyBudgetOrder = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** Per-unit price expressed in `instrument_ccy`. */
  price: number;
  /** Currency the price is quoted in (e.g. "USD" for AAPL). */
  instrument_ccy: string;
};

export type FxLeg = {
  fromCcy: string;
  toCcy: string;
  /** Amount debited from `fromCcy`. */
  amountFrom: number;
  /** Amount credited to `toCcy` (`amountFrom * rate`). */
  amountTo: number;
  rate: number;
  /** True if the rate was flagged stale by the resolver. */
  stale: boolean;
  /** Which buy triggered the conversion, for auditability. */
  triggeredBySymbol: string;
};

export type MultiCcyBudgetDecision =
  | {
      kind: "allow";
      order: MultiCcyBudgetOrder;
      notionalNative: number;
      /** Any FX leg the trimmer generated to fund this specific buy. */
      fxLeg?: FxLeg;
    }
  | {
      kind: "skip";
      order: MultiCcyBudgetOrder;
      notionalNative: number;
      reason: string;
    };

export type TrimBuysMultiCcyResult = {
  decisions: MultiCcyBudgetDecision[];
  fxLegs: FxLeg[];
  /** Wallet snapshot after all allowed buys + FX legs. Ready to persist. */
  finalWallet: Record<string, number>;
  totalRequestedByCcy: Record<string, number>;
  totalAllowedByCcy: Record<string, number>;
  skippedCount: number;
};

export type FxResolver = (from: string, to: string) => number | null;
export type FxStaleFlag = (from: string, to: string) => boolean;

export function trimBuysToBudgetByCurrency(
  buys: MultiCcyBudgetOrder[],
  initialWallet: Record<string, number>,
  baseCcy: string,
  fx: FxResolver,
  opts?: {
    /** Held back from each currency's balance to absorb rounding/spread. */
    safetyBufferPct?: number;
    /** When false, cross-currency buys can only draw from that same currency. */
    allowFxConversion?: boolean;
    isRateStale?: FxStaleFlag;
    /**
     * Optional FX cost hook. When provided, the trimmer inflates the
     * base-currency debit by (1 + bps/10000) so a JPY/AUD shortfall funded
     * from GBP actually reserves the extra cash the broker will consume as
     * spread/markup — otherwise the buy squeezes through wallet math but
     * fails at the broker.
     */
    fxCostBps?: (fromCcy: string, toCcy: string) => number;
  },
): TrimBuysMultiCcyResult {
  const safetyPct = opts?.safetyBufferPct ?? 0.01;
  const allowFx = opts?.allowFxConversion ?? true;
  const base = baseCcy.toUpperCase();


  // Working wallet — apply the buffer up-front so every downstream compare is
  // against the "safe" balance, not the raw one. The persisted balance still
  // reflects the actual debits, not the buffered view.
  const wallet: Record<string, number> = {};
  const buffered: Record<string, number> = {};
  for (const [k, v] of Object.entries(initialWallet)) {
    const n = Number.isFinite(v) ? Number(v) : 0;
    const K = k.toUpperCase();
    wallet[K] = n;
    buffered[K] = Math.max(0, n * (1 - safetyPct));
  }

  const decisions: MultiCcyBudgetDecision[] = [];
  const fxLegs: FxLeg[] = [];
  const totalRequestedByCcy: Record<string, number> = {};
  const totalAllowedByCcy: Record<string, number> = {};

  const bump = (m: Record<string, number>, k: string, v: number) => {
    m[k] = (m[k] ?? 0) + v;
  };

  const debit = (ccy: string, amount: number) => {
    wallet[ccy] = (wallet[ccy] ?? 0) - amount;
    buffered[ccy] = (buffered[ccy] ?? 0) - amount;
  };
  const credit = (ccy: string, amount: number) => {
    wallet[ccy] = (wallet[ccy] ?? 0) + amount;
    buffered[ccy] = Math.max(0, (wallet[ccy] ?? 0) * (1 - safetyPct));
  };

  const safeRate = (from: string, to: string): { rate: number; stale: boolean } | null => {
    if (from === to) return { rate: 1, stale: false };
    const raw = fx(from, to);
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
    return { rate: raw, stale: opts?.isRateStale?.(from, to) ?? false };
  };

  for (const o of buys) {
    if (o.side !== "buy") continue;
    const ccy = (o.instrument_ccy || base).toUpperCase();
    const notionalNative = Math.max(0, Number(o.quantity) || 0) * Math.max(0, Number(o.price) || 0);
    bump(totalRequestedByCcy, ccy, notionalNative);

    if (notionalNative <= 0) {
      decisions.push({ kind: "skip", order: o, notionalNative, reason: "zero notional" });
      continue;
    }

    const availableNative = buffered[ccy] ?? 0;

    // Enough in the target currency already — no FX needed.
    if (notionalNative <= availableNative + 1e-6) {
      debit(ccy, notionalNative);
      bump(totalAllowedByCcy, ccy, notionalNative);
      decisions.push({ kind: "allow", order: o, notionalNative });
      continue;
    }

    // Short in target currency. Try to fund from base_ccy via FX.
    if (!allowFx || ccy === base) {
      decisions.push({
        kind: "skip",
        order: o,
        notionalNative,
        reason: `insufficient ${ccy} cash: needs ${notionalNative.toFixed(2)}, ${availableNative.toFixed(2)} available (fx disabled)`,
      });
      continue;
    }

    const shortfall = notionalNative - availableNative;
    const rateInfo = safeRate(base, ccy);
    if (!rateInfo) {
      decisions.push({
        kind: "skip",
        order: o,
        notionalNative,
        reason: `insufficient ${ccy} cash and fx ${base}->${ccy} unresolved`,
      });
      continue;
    }

    // base × rate = native → baseNeeded = shortfall / rate.
    // Inflate the base debit by the pair-specific FX cost so we set aside
    // enough GBP/EUR to survive the wallet spread + markup at settlement.
    const bps = Math.max(0, opts?.fxCostBps?.(base, ccy) ?? 0);
    const grossUp = bps > 0 ? 1 + bps / 10_000 : 1;
    const baseNeeded = (shortfall / rateInfo.rate) * grossUp;
    const baseAvailable = buffered[base] ?? 0;
    if (baseNeeded > baseAvailable + 1e-6) {
      decisions.push({
        kind: "skip",
        order: o,
        notionalNative,
        reason: `insufficient ${ccy} (${availableNative.toFixed(2)}) and insufficient ${base} to convert (need ${baseNeeded.toFixed(2)}, have ${baseAvailable.toFixed(2)})`,
      });
      continue;
    }

    // Execute the FX leg: debit base, credit target, then debit the buy.
    debit(base, baseNeeded);
    credit(ccy, shortfall);
    const leg: FxLeg = {
      fromCcy: base,
      toCcy: ccy,
      amountFrom: baseNeeded,
      amountTo: shortfall,
      rate: rateInfo.rate,
      stale: rateInfo.stale,
      triggeredBySymbol: o.symbol,
    };
    fxLegs.push(leg);


    debit(ccy, notionalNative);
    bump(totalAllowedByCcy, ccy, notionalNative);
    decisions.push({ kind: "allow", order: o, notionalNative, fxLeg: leg });
  }

  // Persist snapshot — clamp any tiny negative residues from FP noise.
  const finalWallet: Record<string, number> = {};
  for (const [k, v] of Object.entries(wallet)) {
    finalWallet[k] = Math.abs(v) < 1e-9 ? 0 : v;
  }

  return {
    decisions,
    fxLegs,
    finalWallet,
    totalRequestedByCcy,
    totalAllowedByCcy,
    skippedCount: decisions.filter((d) => d.kind === "skip").length,
  };
}
