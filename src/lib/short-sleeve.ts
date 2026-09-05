// Short sleeve — cash-funded short exposure via inverse (short) UCITS ETFs.
//
// Policy decided with the account owner:
//   • NEVER spend money the account does not hold. Every short position is
//     expressed by BUYING an inverse ETF with settled cash, so the maximum
//     loss is the cash staked. No margin, no borrow, no CFDs, no naked shorts.
//   • Total money staked (longs + shorts, at market value) may never exceed
//     account NAV — a hard gross cap.
//   • Sizing is NET-AWARE: a short offsets long risk, so the invested-%
//     ceiling looks at net exposure (long − short) while the gross cap keeps
//     the absolute stake bounded.
//   • The short sleeve is capped at a configurable share of NAV (default 50%).
//
// This module is pure. It computes budgets and verdicts; execution and
// persistence belong to the caller.

export type ShortProxy = {
  /** Tradeable inverse ETF (Yahoo syntax; LSE-listed, GBP, UCITS). */
  symbol: string;
  name: string;
  /** What the proxy is short of, in plain language. */
  exposure: string;
  /** Underlying symbols in our universe whose downside this proxy expresses. */
  underlyings: string[];
  /** Daily-reset (-1x) products compound path-dependently. */
  dailyReset: boolean;
};

/**
 * Curated, cash-account-tradeable inverse ETFs. All are UCITS, LSE-listed and
 * GBP-settled, so a plain Saxo stock account can buy them outright — US
 * inverse ETFs (SH, SDS, …) are not distributable to UK retail clients.
 */
export const SHORT_PROXIES: ShortProxy[] = [
  {
    symbol: "XUKS.L",
    name: "Xtrackers FTSE 100 Short Daily Swap UCITS ETF",
    exposure: "-1x FTSE 100",
    underlyings: ["ISF.L", "VUKE.L", "^FTSE"],
    dailyReset: true,
  },
  {
    symbol: "XSPS.L",
    name: "Xtrackers S&P 500 Inverse Daily Swap UCITS ETF",
    exposure: "-1x S&P 500",
    underlyings: ["SPY", "VUSA.L", "VTI", "^GSPC"],
    dailyReset: true,
  },
];

const BY_SYMBOL = new Map(SHORT_PROXIES.map((p) => [p.symbol.toUpperCase(), p]));

/** Sessions after which a daily-reset inverse ETF should be reviewed/closed. */
export const SHORT_PROXY_MAX_HOLD_DAYS = 15;

export function isShortProxy(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return BY_SYMBOL.has(String(symbol).toUpperCase());
}

export function shortProxyMeta(symbol: string): ShortProxy | null {
  return BY_SYMBOL.get(String(symbol).toUpperCase()) ?? null;
}

/** Which proxy expresses a bearish view on `underlying`, if any. */
export function shortProxyForUnderlying(underlying: string): ShortProxy | null {
  const u = String(underlying).toUpperCase();
  return SHORT_PROXIES.find((p) => p.underlyings.some((x) => x.toUpperCase() === u)) ?? null;
}

export type ExposureSplit = {
  /** Market value of ordinary (long) holdings. */
  longValue: number;
  /** Market value held in inverse ETFs — the short sleeve. */
  shortValue: number;
  /** longValue + shortValue: total money staked in the market. */
  grossValue: number;
  /** longValue - shortValue: directional exposure after the hedge. */
  netValue: number;
  grossPctNav: number;
  netPctNav: number;
  shortPctNav: number;
};

/**
 * Split a holdings book into long vs short-sleeve exposure.
 * `holdings` values are market values in base currency.
 */
export function splitExposure(
  holdings: Array<{ symbol: string; value: number }>,
  nav: number,
): ExposureSplit {
  let longValue = 0;
  let shortValue = 0;
  for (const h of holdings) {
    const v = Number.isFinite(h.value) ? Math.max(0, h.value) : 0;
    if (isShortProxy(h.symbol)) shortValue += v;
    else longValue += v;
  }
  const grossValue = longValue + shortValue;
  const netValue = longValue - shortValue;
  const denom = nav > 0 ? nav : 0;
  return {
    longValue,
    shortValue,
    grossValue,
    netValue,
    grossPctNav: denom ? grossValue / denom : 0,
    netPctNav: denom ? netValue / denom : 0,
    shortPctNav: denom ? shortValue / denom : 0,
  };
}

export type ShortSleeveInputs = {
  /** Total account value (cash + holdings) in base currency. */
  nav: number;
  /** Cash the engine may deploy this tick (already net of the cash floor). */
  spendableCash: number;
  longValue: number;
  shortValue: number;
  /** Spend the sizer wants to put into the inverse ETF. */
  proposedSpend: number;
  /** Sleeve ceiling as a fraction of NAV (0..1). */
  maxSleevePct: number;
  enabled: boolean;
};

export type ShortSleeveVerdict = {
  ok: boolean;
  /** Spend permitted after every cap. 0 when `ok` is false. */
  allowedSpend: number;
  /** Reason the buy was refused, when `ok` is false. */
  rejected?: string;
  note: string;
  sleeveRoom: number;
  grossRoom: number;
  cashRoom: number;
};

/**
 * Gate a proposed inverse-ETF buy. Returns the largest spend that keeps every
 * invariant true: cash-funded, sleeve ≤ maxSleevePct of NAV, and
 * long + short ≤ NAV.
 */
export function gateShortSleeveBuy(inputs: ShortSleeveInputs): ShortSleeveVerdict {
  const nav = Number.isFinite(inputs.nav) && inputs.nav > 0 ? inputs.nav : 0;
  const cashRoom = Math.max(0, Number.isFinite(inputs.spendableCash) ? inputs.spendableCash : 0);
  const longValue = Math.max(0, inputs.longValue || 0);
  const shortValue = Math.max(0, inputs.shortValue || 0);
  const proposed = Math.max(0, inputs.proposedSpend || 0);
  const sleevePct = Math.max(0, Math.min(1, inputs.maxSleevePct));

  const base = { sleeveRoom: 0, grossRoom: 0, cashRoom };

  if (!inputs.enabled) {
    return { ...base, ok: false, allowedSpend: 0, rejected: "short sleeve disabled", note: "shorts off" };
  }
  if (nav <= 0) {
    return { ...base, ok: false, allowedSpend: 0, rejected: "short sleeve: no NAV", note: "no NAV" };
  }

  const sleeveRoom = Math.max(0, sleevePct * nav - shortValue);
  // Hard gross cap: money staked (longs + shorts) can never exceed the account.
  const grossRoom = Math.max(0, nav - (longValue + shortValue));

  if (sleeveRoom <= 0) {
    return {
      ok: false,
      allowedSpend: 0,
      rejected: `short sleeve full: ${(shortValue / nav * 100).toFixed(0)}% of NAV already short (cap ${(sleevePct * 100).toFixed(0)}%)`,
      note: "sleeve cap",
      sleeveRoom,
      grossRoom,
      cashRoom,
    };
  }
  if (grossRoom <= 0) {
    return {
      ok: false,
      allowedSpend: 0,
      rejected: `gross exposure cap: longs + shorts already ${(((longValue + shortValue) / nav) * 100).toFixed(0)}% of account value`,
      note: "gross cap",
      sleeveRoom,
      grossRoom,
      cashRoom,
    };
  }
  if (cashRoom <= 0) {
    return {
      ok: false,
      allowedSpend: 0,
      rejected: "short sleeve: no spendable cash — shorts are cash-funded, never borrowed",
      note: "no cash",
      sleeveRoom,
      grossRoom,
      cashRoom,
    };
  }

  const allowedSpend = Math.min(proposed, sleeveRoom, grossRoom, cashRoom);
  const binding =
    allowedSpend === proposed
      ? "unconstrained"
      : allowedSpend === sleeveRoom
        ? `sleeve≤${(sleevePct * 100).toFixed(0)}% NAV`
        : allowedSpend === grossRoom
          ? "gross≤100% NAV"
          : "cash-funded";
  return {
    ok: allowedSpend > 0,
    allowedSpend,
    rejected: allowedSpend > 0 ? undefined : "short sleeve: no room after caps",
    note: `short sleeve ${binding}`,
    sleeveRoom,
    grossRoom,
    cashRoom,
  };
}

/**
 * Net-aware invested value for the cash-allocation policy. A short sleeve
 * hedges the book rather than adding directional risk, so the invested-%
 * ceiling is measured on net exposure. Never negative; the gross cap in
 * `gateShortSleeveBuy` remains the absolute limit on money staked.
 */
export function netAwareInvestedValue(longValue: number, shortValue: number): number {
  return Math.max(0, (longValue || 0) - (shortValue || 0));
}

/**
 * Daily-reset inverse ETFs decay in choppy tape. Flag positions held past the
 * review horizon so the exit layer closes or refreshes them.
 */
export function shortProxyStaleHold(symbol: string, heldDays: number): { stale: boolean; note: string } {
  const meta = shortProxyMeta(symbol);
  if (!meta || !meta.dailyReset) return { stale: false, note: "" };
  if (heldDays <= SHORT_PROXY_MAX_HOLD_DAYS) return { stale: false, note: "" };
  return {
    stale: true,
    note: `${symbol} is a daily-reset ${meta.exposure} tracker held ${heldDays}d (>${SHORT_PROXY_MAX_HOLD_DAYS}d) — compounding drag; close or re-establish`,
  };
}

/** Prompt block describing the short sleeve and its live room. */
export function formatShortSleeveBlock(args: {
  enabled: boolean;
  nav: number;
  exposure: ExposureSplit;
  maxSleevePct: number;
  currency: string;
}): string {
  if (!args.enabled) {
    return "SHORT SLEEVE: disabled — long-only this run. Do not propose inverse ETFs.";
  }
  const { exposure: e, nav, maxSleevePct: cap, currency: ccy } = args;
  const room = Math.max(0, cap * nav - e.shortValue);
  const grossRoom = Math.max(0, nav - e.grossValue);
  const lines = [
    "SHORT SLEEVE (cash-funded, inverse ETFs only — no margin, no borrowing, no naked stock shorts):",
    `  Available proxies: ${SHORT_PROXIES.map((p) => `${p.symbol} (${p.exposure}; proxy for ${p.underlyings.join("/")})`).join(", ")}`,
    `  How to take a short: place side=buy on the proxy, never side=sell on an unheld stock. A sell only closes something already held.`,
    `  Current: long ${((e.longValue / (nav || 1)) * 100).toFixed(0)}% NAV, short ${(e.shortPctNav * 100).toFixed(0)}% NAV, net ${(e.netPctNav * 100).toFixed(0)}%, gross ${(e.grossPctNav * 100).toFixed(0)}%`,
    `  Sleeve room: ${ccy} ${room.toFixed(0)} (cap ${(cap * 100).toFixed(0)}% NAV). Gross room: ${ccy} ${grossRoom.toFixed(0)} (longs + shorts may never exceed 100% NAV).`,
    `  Buy an inverse ETF only for a deliberate bearish or hedging view. They reset daily, so treat them as tactical (review by ${SHORT_PROXY_MAX_HOLD_DAYS} sessions), never buy-and-hold.`,
  ];
  return lines.join("\n");
}
