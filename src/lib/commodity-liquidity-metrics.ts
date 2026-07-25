// Pure helper — compute liquidity/spread/rejection-risk metrics for a single
// commodity trade sizing decision. Shared between the daily trading engine
// (so executed rows carry the numbers used to size the trade) and the
// commodity slippage/liquidity simulator card. Keep pure so it is safe to
// import from client bundles for typing / re-computation.

export type CommodityTradeLiquidity = {
  adv_20d_usd: number | null;      // 20d average dollar volume
  atr_pct: number | null;          // realized-vol proxy (fraction)
  spread_bps: number | null;       // spread proxy in bps (atr_pct * 10_000)
  est_slippage_bps: number;        // half-spread + fixed slippage (per side)
  est_turnover_pct_adv: number | null; // requested spend as % of 20d ADV$
  liquidity_cap_spend: number | null;  // 1% ADV notional cap (null if unknown)
  trim_fraction: number;           // 0 → no trim, 1 → fully trimmed
  rejection_score: number;         // 0-100 blended sizing-risk score
  rejection_bucket: "low" | "medium" | "high";
};

// Mirrors weights used in `simulateCommodityLiquidity` so both surfaces line up.
const SPREAD_ATR_FRAC = 0.25;
const SLIPPAGE_BPS = 8;

function bucket(score: number): "low" | "medium" | "high" {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

export function computeCommodityTradeLiquidity(args: {
  requestedSpend: number;
  price: number;
  atrPct: number | null;
  adv20d: number | null; // shares (matches feature row units)
  liquidityCappedSpend: number | null;
}): CommodityTradeLiquidity {
  const advUsd = args.adv20d != null && args.price > 0
    ? args.adv20d * args.price
    : null;

  const spreadBps = args.atrPct != null && args.atrPct > 0
    ? args.atrPct * 10_000
    : null;

  const halfSpreadBps = args.atrPct && args.atrPct > 0
    ? args.atrPct * SPREAD_ATR_FRAC * 10_000
    : 0;
  const estSlippageBps = halfSpreadBps + SLIPPAGE_BPS;

  const turnoverPctAdv = advUsd != null && advUsd > 0
    ? (args.requestedSpend / advUsd) * 100
    : null;

  const trimFraction = args.liquidityCappedSpend != null && args.requestedSpend > 0
    ? Math.max(0, Math.min(1, 1 - args.liquidityCappedSpend / args.requestedSpend))
    : 0;

  const trimScore = Math.min(100, trimFraction * 120);
  const spreadScore = spreadBps == null
    ? 60
    : Math.min(100, (spreadBps / 200) * 100);
  const advScore = advUsd == null
    ? 80
    : advUsd < 250_000
      ? 100
      : advUsd < 1_000_000
        ? 70
        : advUsd < 10_000_000
          ? 30
          : 5;
  const rejectionScore = Math.round(
    trimScore * 0.4 + spreadScore * 0.25 + advScore * 0.35,
  );

  return {
    adv_20d_usd: advUsd,
    atr_pct: args.atrPct,
    spread_bps: spreadBps,
    est_slippage_bps: estSlippageBps,
    est_turnover_pct_adv: turnoverPctAdv,
    liquidity_cap_spend: args.liquidityCappedSpend,
    trim_fraction: trimFraction,
    rejection_score: rejectionScore,
    rejection_bucket: bucket(rejectionScore),
  };
}
