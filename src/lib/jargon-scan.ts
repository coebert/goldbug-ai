// Scans arbitrary text for known glossary terms and returns interleaved
// plain / term segments so callers can render clickable "Explain" popovers
// inline. Case-insensitive, whole-word matching, longest-match-wins so
// "max drawdown" beats "drawdown", and each term is only wrapped on its
// first appearance per string (a paragraph shouldn't be a sea of dotted
// underlines).

import { GLOSSARY, type TermId } from "./glossary";

export type JargonSegment =
  | { kind: "text"; text: string }
  | { kind: "term"; text: string; term: TermId };

/**
 * Aliases for the glossary. Keys are the surface phrases users see in the
 * app; values are the canonical TermId. Order does not matter — the
 * scanner sorts by length descending so multi-word phrases win.
 *
 * Keep phrases lowercase; matching is case-insensitive.
 */
const ALIASES: Record<string, TermId> = {
  // metrics
  "sharpe ratio": "sharpe",
  sharpe: "sharpe",
  "max drawdown": "max_drawdown",
  "maximum drawdown": "max_drawdown",
  drawdown: "max_drawdown",
  mdd: "max_drawdown",
  cagr: "cagr",
  "annualised return": "cagr",
  "annualized return": "cagr",
  volatility: "volatility",
  alpha: "alpha",
  slippage: "slippage",
  "transaction cost": "transaction_cost",
  "transaction costs": "transaction_cost",
  fees: "transaction_cost",
  "equity curve": "equity_curve",
  benchmark: "benchmark",
  "p&l": "pnl",
  pnl: "pnl",
  "profit and loss": "pnl",
  "profit & loss": "pnl",

  // signals & AI
  rsi: "rsi",
  sma: "sma",
  "moving average": "sma",
  atr: "atr",
  conviction: "conviction",
  regime: "regime",
  "market regime": "regime",
  "signal importance": "signal_importance",

  // risk
  "risk level": "risk_level",
  "stop-loss": "stop_loss",
  "stop loss": "stop_loss",
  "take-profit": "take_profit",
  "take profit": "take_profit",
  "cash floor": "cash_floor",
  "max position": "max_position",
  "position size": "max_position",
  "volatility-based sizing": "inverse_vol_sizing",
  "inverse-vol sizing": "inverse_vol_sizing",
  guardrail: "guardrail",
  guardrails: "guardrail",

  // modes / money
  backtest: "backtest",
  "starting pot": "starting_pot",
  universe: "universe",
  "asset universe": "universe",

  // broker
  "kill switch": "kill_switch",
  "access token": "access_token",
  "refresh token": "refresh_token",
};

// Precompute sorted alias list (longest first) once at module load. The
// scanner walks the string using each alias in turn, so this ordering
// guarantees "max drawdown" wraps before the substring "drawdown" gets a
// chance.
const SORTED_ALIASES: Array<{ phrase: string; term: TermId }> = Object.entries(
  ALIASES,
)
  .filter(([, term]) => term in GLOSSARY)
  .map(([phrase, term]) => ({ phrase, term }))
  .sort((a, b) => b.phrase.length - a.phrase.length);

const WORD_CHAR = /[A-Za-z0-9]/;

function isWordBoundary(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text[start - 1];
  const after = end >= text.length ? "" : text[end];
  const beforeOk = !before || !WORD_CHAR.test(before);
  const afterOk = !after || !WORD_CHAR.test(after);
  return beforeOk && afterOk;
}

export function scanJargon(input: string): JargonSegment[] {
  if (!input) return [];
  const lower = input.toLowerCase();
  // occupancy map — chars already claimed by an earlier (longer) match
  const claimed = new Uint8Array(input.length);
  type Hit = { start: number; end: number; term: TermId };
  const hits: Hit[] = [];
  const seen = new Set<TermId>(); // first-hit-only per term per string

  for (const { phrase, term } of SORTED_ALIASES) {
    if (seen.has(term)) continue;
    let from = 0;
    while (from <= lower.length - phrase.length) {
      const idx = lower.indexOf(phrase, from);
      if (idx === -1) break;
      const end = idx + phrase.length;
      // skip if any char in the span is already claimed
      let overlap = false;
      for (let i = idx; i < end; i++) {
        if (claimed[i]) {
          overlap = true;
          break;
        }
      }
      if (!overlap && isWordBoundary(input, idx, end)) {
        hits.push({ start: idx, end, term });
        for (let i = idx; i < end; i++) claimed[i] = 1;
        seen.add(term);
        break; // first hit only
      }
      from = idx + 1;
    }
  }

  if (hits.length === 0) return [{ kind: "text", text: input }];
  hits.sort((a, b) => a.start - b.start);
  const out: JargonSegment[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start > cursor)
      out.push({ kind: "text", text: input.slice(cursor, h.start) });
    out.push({ kind: "term", text: input.slice(h.start, h.end), term: h.term });
    cursor = h.end;
  }
  if (cursor < input.length)
    out.push({ kind: "text", text: input.slice(cursor) });
  return out;
}
