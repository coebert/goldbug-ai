// Carry proxy — without live yield/dividend feeds, we approximate carry
// with three ideas:
//   • Low realised vol + gently positive drift = "cash-like carry" (e.g.
//     short-duration bond ETFs, quality dividend payers).
//   • Asset-class hint: bond/dividend/gold-adjacent proxies get a small
//     baseline carry credit; commodities and single-name equities do not.
//   • Very low ATR% amplifies (implied yield-like stability).
// Bounded and small — carry is a tilt, not a primary driver.
import { clamp1, type AlphaScore, type FeatureLike } from "./types";

const CARRY_FRIENDLY = new Set(["bond", "credit", "yield", "dividend", "cash"]);

export function scoreCarry(f: FeatureLike): AlphaScore {
  const parts: number[] = [];
  const notes: string[] = [];

  const cls = (f.asset_class ?? "").toLowerCase();
  const friendly = CARRY_FRIENDLY.has(cls);
  if (friendly) {
    parts.push(0.4);
    notes.push(`${cls} carry-friendly`);
  }
  if (f.vol20d != null && f.vol20d < 0.01) {
    parts.push(0.6);
    notes.push("ultra-low vol");
  } else if (f.vol20d != null && f.vol20d < 0.02) {
    parts.push(0.3);
  } else {
    parts.push(-0.1);
  }
  if (f.change30d != null && f.change30d > 0 && f.change30d < 0.05) {
    parts.push(0.4);
    notes.push("gentle drift");
  }
  if (f.atr_pct != null && f.atr_pct < 0.01) parts.push(0.3);

  const raw = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return {
    symbol: f.symbol,
    kind: "carry",
    score: clamp1(raw),
    reason: notes.length ? notes.join(", ") : "no carry edge",
  };
}
