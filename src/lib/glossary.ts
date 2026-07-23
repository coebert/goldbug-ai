// Central glossary. Every entry is written for someone who has never traded before.
// Keep language plain, short, and free of extra jargon. If a term inside an
// explanation would itself confuse a beginner, rewrite around it.

export type GlossaryEntry = {
  title: string;
  short: string;
  why: string;
  rule?: string;
  example?: string;
};

export const GLOSSARY = {
  // ---------------- Money & modes ----------------
  backtest: {
    title: "Backtest",
    short:
      "A test run that replays past market prices to see how the AI would have traded during that period.",
    why: "Lets you check the strategy on real historical data without risking any money — nothing here touches your bank or broker.",
  },
  live_sim: {
    title: "Simulated cash · live",
    short:
      "The AI trades against today's live prices, but only with pretend money. No real money moves.",
    why: "Useful for watching the AI work in real market conditions before ever considering real cash.",
  },
  live_prod: {
    title: "Real money",
    short:
      "Approved orders are sent to your live broker account and executed with real money.",
    why: "This is the only mode that can actually cost or make you money. Use with care.",
  },
  starting_pot: {
    title: "Starting pot",
    short: "How much pretend (or real) cash the portfolio starts with.",
    why: "All performance is measured against this number. Aegis never adds more later, and never borrows.",
    example: "£1000 starting pot → the AI can only buy up to £1000 worth of assets.",
  },
  universe: {
    title: "Asset universe",
    short: "The types of things the AI is allowed to buy — stocks, ETFs, crypto, commodities, or FX.",
    why: "A narrower universe is easier to understand. A wider one gives the AI more options.",
  },
  pnl: {
    title: "P&L (profit & loss)",
    short: "How much you're up or down compared to your starting pot.",
    why: "The single simplest measure of whether the portfolio is winning or losing.",
  },

  // ---------------- Risk controls ----------------
  risk_level: {
    title: "Risk level",
    short:
      "How aggressive you want the AI to be. Higher risk allows bigger positions and less cash held aside.",
    why: "Higher risk can mean bigger gains but also bigger losses. Lower risk is calmer but slower.",
    rule: "Conservative: max 10% per asset, keep 20% cash. Balanced: 15% / 10%. Aggressive: 25% / 0%.",
  },
  max_position: {
    title: "Max position size",
    short: "The largest share of your pot the AI can put into any single asset.",
    why: "Stops the AI putting all its eggs in one basket. If one asset crashes, only that slice is hurt.",
    example: "15% cap on a £1000 pot = maximum £150 in any one asset.",
  },
  stop_loss: {
    title: "Stop-loss",
    short:
      "An automatic sell if a position drops by a set percentage from what you paid for it.",
    why: "Caps how much you can lose on any single trade — it exits before a small loss becomes a big one.",
    example: "Stop-loss 8% → if you bought at 100 and it falls to 92, it auto-sells.",
  },
  take_profit: {
    title: "Take-profit",
    short:
      "An automatic sell once a position has gained a set percentage — locking in the profit.",
    why: "Stops you (or the AI) getting greedy and giving back a good gain.",
  },
  cash_floor: {
    title: "Cash floor",
    short: "A minimum amount of the pot always kept in cash, never invested.",
    why: "Gives the AI room to buy dips and cushions the portfolio during crashes.",
  },
  inverse_vol_sizing: {
    title: "Volatility-based sizing",
    short:
      "The AI puts smaller amounts into wilder, jumpier assets and larger amounts into steadier ones.",
    why: "Equalises risk across positions. Without it, one wild asset can dominate the portfolio's swings.",
  },
  guardrail: {
    title: "Guardrails",
    short:
      "Automatic safety checks that must all pass before an order is allowed to happen (position size, cash floor, borrowing ban, and more).",
    why: "The AI can suggest anything, but a trade only executes if every guardrail approves it. Aegis never borrows or uses leverage.",
  },

  // ---------------- Signals & AI decisions ----------------
  rsi: {
    title: "RSI (Relative Strength Index)",
    short:
      "A number between 0 and 100 that says how 'overbought' or 'oversold' a recent price move looks.",
    why: "Traders often treat above 70 as overbought (may fall back) and below 30 as oversold (may bounce). The AI uses it as one clue among many.",
  },
  sma: {
    title: "SMA (Simple Moving Average)",
    short:
      "The average price over the last N days — smooths out day-to-day noise so a trend is easier to see.",
    why: "If the price is above its long moving average, that's usually called an uptrend; below it, a downtrend.",
  },
  atr: {
    title: "ATR (Average True Range)",
    short: "A measure of how much an asset typically moves in a day.",
    why: "Used to set stop-losses that fit the asset. A jumpy asset needs more room than a calm one.",
  },
  conviction: {
    title: "Conviction",
    short: "How confident the AI is in a decision, on a 0–1 scale.",
    why: "Higher conviction usually means a larger position — but the guardrails still cap the maximum size.",
  },
  signal_importance: {
    title: "Signal importance",
    short:
      "A breakdown of which pieces of evidence (trend, momentum, news, etc.) contributed most to a given decision.",
    why: "Lets you sanity-check the AI: was it driven by prices, by news, or something else?",
  },
  regime: {
    title: "Market regime",
    short:
      "A label for the current market mood — for example bull-quiet, bull-volatile, bear, or crisis.",
    why: "The AI adapts its priors when the regime shifts, e.g. taking less risk in a crisis.",
  },

  // ---------------- Charts & metrics ----------------
  equity_curve: {
    title: "Equity curve",
    short:
      "A line chart showing the total value of your portfolio (cash + holdings) over time.",
    why: "The clearest single picture of whether you're winning or losing, and how bumpy the ride is.",
  },
  benchmark: {
    title: "Benchmark",
    short:
      "A well-known market index (like SPY = the S&P 500) shown alongside your portfolio for comparison.",
    why: "Answers 'am I doing better than just buying the market and doing nothing?'",
  },
  cagr: {
    title: "CAGR (annualised return)",
    short: "The steady yearly growth rate that would produce the same final result.",
    why: "Lets you compare portfolios or strategies on an apples-to-apples yearly basis.",
    rule: "A long-run stock-market average is roughly 7–10% CAGR. Above that consistently is impressive.",
  },
  volatility: {
    title: "Volatility",
    short: "How bumpy the ride is — the size of typical daily swings, annualised.",
    why: "Higher volatility means bigger ups AND bigger downs. Not automatically bad, but harder to stomach.",
    rule: "For reference, the S&P 500 has typically been around 15–20% annual volatility.",
  },
  sharpe: {
    title: "Sharpe ratio",
    short:
      "Return per unit of bumpiness. Roughly: 'how much extra return did I get for the risk I took?'",
    why: "Two portfolios with the same return but different volatility aren't equal. Sharpe rewards the steadier one.",
    rule: "Above 1.0 is generally considered good. Above 2.0 is excellent. Negative means you'd have been better off in cash.",
  },
  max_drawdown: {
    title: "Max drawdown",
    short:
      "The biggest peak-to-trough drop the portfolio has ever suffered, in percent.",
    why: "Tells you the worst-case pain so far. A great return with a 60% drawdown is a very different experience from the same return with a 10% drawdown.",
    rule: "Under 20% is comfortable for most people. Over 40% is hard to sit through without panicking.",
  },
  alpha: {
    title: "Alpha",
    short: "How much the portfolio beat (or missed) the benchmark by.",
    why: "Positive alpha means the AI is genuinely adding value versus just buying the index.",
  },
  slippage: {
    title: "Slippage",
    short:
      "The small difference between the price you expected and the price you actually got when the order filled.",
    why: "Real markets aren't perfectly liquid. Ignoring slippage flatters backtests.",
  },
  transaction_cost: {
    title: "Transaction cost",
    short: "Fees and spreads the broker charges each time you buy or sell.",
    why: "Frequent trading eats returns. Realistic costs make backtests match reality more closely.",
  },

  // ---------------- Broker / OAuth ----------------
  sim_vs_live: {
    title: "SIM vs LIVE (Saxo)",
    short:
      "Saxo runs two separate environments: SIM is a full sandbox with fake money, LIVE uses your real Saxo account.",
    why: "They use different logins and different app keys. Aegis keeps them fully separated so real orders can only ever go to LIVE.",
  },
  access_token: {
    title: "Access token",
    short:
      "A short-lived pass (usually ~20 minutes) that lets Aegis talk to Saxo on your behalf.",
    why: "Because it expires quickly, a leaked token has a tiny window of damage. Aegis refreshes it automatically before each use.",
  },
  refresh_token: {
    title: "Refresh token",
    short:
      "A longer-lived credential (~30 days) used to get new access tokens without you logging in again.",
    why: "As long as the app runs at least once every 30 days, the connection stays alive by itself.",
  },
  kill_switch: {
    title: "Kill switch",
    short:
      "A single setting that forces every 'live simulated' portfolio to stay on paper trading, even if it's marked live.",
    why: "A one-flip safety net if you ever want to be sure nothing routes to the broker.",
  },
} as const;

export type TermId = keyof typeof GLOSSARY;

// Learn page groups — order matters for reading flow.
export const LEARN_GROUPS: Array<{ heading: string; terms: TermId[] }> = [
  {
    heading: "Money & modes",
    terms: ["backtest", "live_sim", "live_prod", "starting_pot", "universe", "pnl"],
  },
  {
    heading: "Risk controls",
    terms: [
      "risk_level",
      "max_position",
      "stop_loss",
      "take_profit",
      "cash_floor",
      "inverse_vol_sizing",
      "guardrail",
    ],
  },
  {
    heading: "How the AI decides",
    terms: ["rsi", "sma", "atr", "conviction", "signal_importance", "regime"],
  },
  {
    heading: "Reading the charts",
    terms: [
      "equity_curve",
      "benchmark",
      "cagr",
      "volatility",
      "sharpe",
      "max_drawdown",
      "alpha",
      "slippage",
      "transaction_cost",
    ],
  },
  {
    heading: "Broker connection",
    terms: ["sim_vs_live", "access_token", "refresh_token", "kill_switch"],
  },
];
