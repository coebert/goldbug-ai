// Standing instruction on which kind of name this book should be trading.
//
// The realised record is that small, cheap, thinly traded names churned the
// account: the dealing cost is the same in pounds, the spread is wider, and the
// moves rarely cleared the round trip. This block tells the decision model to
// spend its risk budget on larger, more profitable businesses unless a smaller
// name has an unusually strong, specific case.
//
// It is prompt guidance only. Every hard rule — cost floor, net-edge gate,
// position caps, fundamentals gate — is unchanged and still binding.

export const SCALE_PREFERENCE_BLOCK = `SCALE AND QUALITY PREFERENCE (standing rule for this account)
- Prefer large and mega-cap businesses (roughly USD 50bn+) and broad funds. They carry tighter spreads, and this book's dealing cost is a fixed number of pounds per ticket, so a bigger, deeper name keeps more of the move.
- Prefer demonstrated profitability over cheapness: high return on equity, a wide net margin, positive free cash flow and growing revenue. A high multiple on a genuinely high-quality business is acceptable; the fundamentals score already widens its valuation tolerance for exactly this.
- Treat small and micro-cap names (below roughly USD 2bn) as the exception. Propose one only when the case is specific and strong — a dated hard catalyst, or a top-decile cross-sectional rank with clean accounts — and say so explicitly in your reasoning.
- Do not repeatedly re-trade the same small position. If the strongest idea today is a name this book has cycled through before with no net gain, prefer the best large-cap or broad-fund alternative instead.
- None of this overrides the risk rules: cost floor, net-edge hurdle, position caps and the financial-health gate still decide whether an idea is allowed to trade.`;
