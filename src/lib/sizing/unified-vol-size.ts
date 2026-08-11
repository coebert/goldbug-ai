// Phase 3 item 14 — one vol-sizing path.
//
// Sizing used to run through two near-identical calculations: the engine's
// inline `vol_target_pct * NAV / vol` cap and the risk-parity target from
// alpha/sizing.ts, with a third variant (`volTargetSize`) used by the
// backtester. Three implementations of the same idea drift; this module is
// now the single owner of "how much notional does this symbol's volatility
// allow", and the others delegate to it.
//
// The rule:
//   base target  = targetVolPct * NAV / max(vol, floor)
//   alpha tilt   = (0.5 + |alpha|) when risk parity is on, else 1
//   target       = min(base * tilt, NAV * navCap)
//   room         = max(0, target - existingValue)
//
// Pure, deterministic, monotone-decreasing in `vol`.

export type UnifiedVolSizeInputs = {
  /** Total portfolio value in base currency. */
  totalValue: number;
  /** Realised volatility for the symbol on the same basis as targetVolPct. */
  vol: number | null | undefined;
  /** Per-position vol budget, e.g. 0.015 = 1.5% of NAV of daily vol. */
  targetVolPct: number;
  /** Value already held in this symbol; the cap is on the total position. */
  existingValue?: number;
  /** Hard cap as a fraction of NAV (default 20%). */
  navCap?: number;
  /** When true, tilt the vol budget by alpha magnitude (risk parity). */
  riskParity?: boolean;
  /** |composite alpha| in [0, 1]; only read when riskParity is true. */
  alphaMag?: number | null;
  /** Vol floor so near-flat instruments can't demand infinite size. */
  volFloor?: number;
};

export type UnifiedVolSizeResult = {
  /** Total position value the vol budget allows. */
  targetValue: number;
  /** Headroom left after the existing position (what a buy may spend). */
  room: number;
  /** Multiplier applied by the risk-parity alpha tilt (1 when disabled). */
  tilt: number;
  /** Which rule set the number: "vol", "nav-cap" or "no-vol-data". */
  binding: "vol" | "nav-cap" | "no-vol-data";
  reason: string;
};

const DEFAULT_NAV_CAP = 0.2;
const DEFAULT_VOL_FLOOR = 1e-4;

export function unifiedVolSize(i: UnifiedVolSizeInputs): UnifiedVolSizeResult {
  const nav = Math.max(0, Number(i.totalValue) || 0);
  const navCap = Math.max(0.01, Math.min(1, i.navCap ?? DEFAULT_NAV_CAP));
  const hardCap = nav * navCap;
  const existing = Math.max(0, Number(i.existingValue ?? 0) || 0);
  const rawVol = Number(i.vol ?? 0);

  if (!Number.isFinite(rawVol) || rawVol <= 0) {
    // No vol estimate — the vol budget cannot bind, so only the NAV cap does.
    return {
      targetValue: hardCap,
      room: Math.max(0, hardCap - existing),
      tilt: 1,
      binding: "no-vol-data",
      reason: "no volatility estimate — vol budget not applied",
    };
  }

  const vol = Math.max(i.volFloor ?? DEFAULT_VOL_FLOOR, rawVol);
  const tilt = i.riskParity
    ? 0.5 + Math.max(0, Math.min(1, Number(i.alphaMag ?? 0)))
    : 1;

  const budgetValue = ((i.targetVolPct * nav) / vol) * tilt;
  const targetValue = Math.min(budgetValue, hardCap);
  const binding: "vol" | "nav-cap" = budgetValue <= hardCap ? "vol" : "nav-cap";

  const tiltNote = i.riskParity ? `, α-tilt ×${tilt.toFixed(2)}` : "";
  return {
    targetValue: Math.max(0, targetValue),
    room: Math.max(0, targetValue - existing),
    tilt,
    binding,
    reason:
      binding === "vol"
        ? `vol budget ${(i.targetVolPct * 100).toFixed(2)}% / realised ${(vol * 100).toFixed(2)}%${tiltNote}`
        : `NAV cap ${(navCap * 100).toFixed(0)}% binds ahead of the vol budget${tiltNote}`,
  };
}
