// Housekeeping rule for open FX funding legs.
//
// A funding leg only earns its keep while it is paying for foreign-currency
// holdings. Once the holdings it funded are sold (or it was always bigger than
// the need), what is left is an unhedged currency bet the strategy never asked
// for. This module decides, from the legs and the foreign-currency exposure
// they are supposed to cover, which legs should be closed.

export type HygieneLegInput = {
  symbol: string;
  /** Signed leg size in the pair's base ccy (negative = sold base for quote). */
  quantity: number;
  /** Currency the leg bought (the quote side of the pair). */
  quoteCcy: string;
  /** When the leg was opened (ISO). */
  openedAt: string | null;
  /** Absolute leg size expressed in the currency it bought (quote ccy). */
  notionalQuote: number;
  /** Absolute leg size expressed in the portfolio base ccy. */
  notionalBase: number;
};

export type HygieneVerdict = "matched" | "oversized" | "unused";

export type HygieneAssessment = {
  symbol: string;
  verdict: HygieneVerdict;
  /** Foreign-currency exposure divided by the leg size (1 = exactly funded). */
  coverRatio: number;
  ageDays: number;
  recommendClose: boolean;
  /** Plain-language reason, safe to show in the UI. */
  reason: string;
};

export type HygieneOptions = {
  /** Cover below this share of the leg counts as oversized. */
  oversizedBelow?: number;
  /** Legs with essentially no cover left are "unused" below this share. */
  unusedBelow?: number;
  /** Ignore small legs worth less than this in base ccy. */
  minNotionalBase?: number;
  /** Only nag about an oversized leg once it has sat there this long. */
  minAgeDays?: number;
};

const DEFAULTS: Required<HygieneOptions> = {
  oversizedBelow: 0.75,
  unusedBelow: 0.15,
  minNotionalBase: 250,
  minAgeDays: 7,
};

export function assessFxLegs(
  legs: HygieneLegInput[],
  /** Value of the non-FX holdings held in each currency, in that currency. */
  exposureByCcy: Record<string, number>,
  now: Date = new Date(),
  options: HygieneOptions = {},
): HygieneAssessment[] {
  const opt = { ...DEFAULTS, ...options };

  // Several legs can fund the same currency — share the exposure out across
  // them largest-first so one leg is not credited with cover another provides.
  const byCcy = new Map<string, HygieneLegInput[]>();
  for (const leg of legs) {
    const ccy = leg.quoteCcy.toUpperCase();
    const list = byCcy.get(ccy) ?? [];
    list.push(leg);
    byCcy.set(ccy, list);
  }

  const out: HygieneAssessment[] = [];
  for (const [ccy, group] of byCcy) {
    let remaining = Math.max(0, Number(exposureByCcy[ccy] ?? 0));
    const ordered = [...group].sort(
      (a, b) => Math.abs(b.notionalQuote) - Math.abs(a.notionalQuote),
    );
    for (const leg of ordered) {
      // Leg size measured in the currency it bought, so cover is like-for-like.
      const legSizeQuote = Math.abs(leg.notionalQuote);
      const covered = Math.min(remaining, legSizeQuote);
      remaining -= covered;
      const coverRatio = legSizeQuote > 0 ? covered / legSizeQuote : 1;
      const ageDays = leg.openedAt
        ? Math.max(0, (now.getTime() - new Date(leg.openedAt).getTime()) / 86_400_000)
        : 0;

      let verdict: HygieneVerdict = "matched";
      if (coverRatio < opt.unusedBelow) verdict = "unused";
      else if (coverRatio < opt.oversizedBelow) verdict = "oversized";

      const tooSmallToBother = Math.abs(leg.notionalBase) < opt.minNotionalBase;
      const recommendClose =
        verdict !== "matched" && !tooSmallToBother && ageDays >= opt.minAgeDays;

      out.push({
        symbol: leg.symbol,
        verdict,
        coverRatio,
        ageDays,
        recommendClose,
        reason: explain(verdict, coverRatio, ageDays, ccy, tooSmallToBother, opt.minAgeDays),
      });
    }
  }
  return out;
}

function explain(
  verdict: HygieneVerdict,
  coverRatio: number,
  ageDays: number,
  ccy: string,
  tooSmall: boolean,
  minAgeDays: number,
): string {
  const pct = Math.round(coverRatio * 100);
  const days = Math.floor(ageDays);
  if (verdict === "matched") {
    return `Still funding ${ccy} holdings (${pct}% used).`;
  }
  if (tooSmall) {
    return `Only ${pct}% of it is funding ${ccy} holdings, but it is too small to be worth a closing fee.`;
  }
  if (days < minAgeDays) {
    return `Only ${pct}% of it is funding ${ccy} holdings — opened ${days} day${days === 1 ? "" : "s"} ago, watching it for now.`;
  }
  if (verdict === "unused") {
    return `The ${ccy} holdings it paid for are gone — it has been an open currency bet for ${days} days. Close it.`;
  }
  return `Bigger than the ${ccy} holdings need (${pct}% used) after ${days} days. Close it or trim it.`;
}
