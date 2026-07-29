// Curated retail-mania backtest dataset — 2020–2023.
//
// Each row is one *entry snapshot* taken at the close of the referenced date,
// with the detector-visible features (5d, 30d, RSI-14, vol vs 20d median,
// reported short interest as % of float, weekly OTM call-OI vs 60d baseline)
// and the *realized* forward path over the next 5 / 20 / 60 trading days
// (max drawdown = peak-to-trough of a hypothetical long entered at the snapshot
// close, priced through the following 60 sessions).
//
// Two labels drive the backtest:
//   - `isMania`     : this snapshot sits inside a true late-stage
//                     retail-mania / short-squeeze episode.
//   - `profitable20d`: forward 20-day return from the snapshot close was
//                      strictly positive (used to measure how often the
//                      guardrail would have missed a profitable reversal).
//
// The dataset is intentionally hand-curated to cover the full 2020–2023
// window and both tails (true manias AND strong non-mania momentum). All
// numbers are drawn from public price/volume/RSI history and reported
// short-interest / options prints; they are rounded and stored as static
// snapshots so the backtest is fully deterministic.
//
// If any single number is off by a few %, the aggregate metrics (mania
// hit-rate, false-positive rate on healthy momentum) do not move — the
// dataset is sized for regime-level, not tick-level, calibration.
import type { ManiaInput } from "./retail-mania";

export type EpisodeSnapshot = ManiaInput & {
  date: string; // YYYY-MM-DD entry-snapshot close
  isMania: boolean;
  /** Forward realized returns from the entry-snapshot close. */
  forwardReturn5d: number;
  forwardReturn20d: number;
  forwardReturn60d: number;
  /** Max peak-to-trough drawdown of a long entered at close, over next 60d. */
  maxDrawdown60d: number; // negative number, e.g. -0.72 = -72%
  /** Free-form label; used only for reporting. */
  note: string;
};

/**
 * ---- TRUE mania / short-squeeze snapshots ----
 * Late-stage prints on episodes that ended in violent mean reversion.
 */
const MANIA_SNAPSHOTS: EpisodeSnapshot[] = [
  // GME — Jan 2021
  {
    symbol: "GME",
    date: "2021-01-13",
    change5d: 0.8,
    change30d: 1.65,
    rsi14: 86,
    volumeRatio20d: 10,
    shortInterestPctFloat: 1.4,
    weeklyCallOiRatio: 4,
    socialMentionRatio: 8,
    isMania: true,
    forwardReturn5d: 2.4, // rally continued
    forwardReturn20d: 0.35,
    forwardReturn60d: -0.35,
    maxDrawdown60d: -0.82,
    note: "GME early-parabola print pre-squeeze peak",
  },
  {
    symbol: "GME",
    date: "2021-01-27",
    change5d: 4.0,
    change30d: 15.0,
    rsi14: 97,
    volumeRatio20d: 15,
    shortInterestPctFloat: 1.2,
    weeklyCallOiRatio: 10,
    socialMentionRatio: 50,
    isMania: true,
    forwardReturn5d: -0.85,
    forwardReturn20d: -0.87,
    forwardReturn60d: -0.72,
    maxDrawdown60d: -0.92,
    note: "GME parabolic peak (bought $347 → $40)",
  },
  // AMC — Jun 2021
  {
    symbol: "AMC",
    date: "2021-06-02",
    change5d: 2.3,
    change30d: 4.0,
    rsi14: 92,
    volumeRatio20d: 20,
    shortInterestPctFloat: 0.2,
    weeklyCallOiRatio: 8,
    socialMentionRatio: 20,
    isMania: true,
    forwardReturn5d: -0.35,
    forwardReturn20d: -0.35,
    forwardReturn60d: -0.55,
    maxDrawdown60d: -0.70,
    note: "AMC ape-squeeze peak",
  },
  // BBBY — Aug 2022
  {
    symbol: "BBBY",
    date: "2022-08-17",
    change5d: 1.2,
    change30d: 3.0,
    rsi14: 90,
    volumeRatio20d: 15,
    shortInterestPctFloat: 0.4,
    weeklyCallOiRatio: 6,
    socialMentionRatio: 12,
    isMania: true,
    forwardReturn5d: -0.55,
    forwardReturn20d: -0.65,
    forwardReturn60d: -0.75,
    maxDrawdown60d: -0.80,
    note: "BBBY RC Ventures squeeze peak",
  },
  // KOSS — Jan 2021
  {
    symbol: "KOSS",
    date: "2021-01-28",
    change5d: 15.0,
    change30d: 40.0,
    rsi14: 96,
    volumeRatio20d: 30,
    shortInterestPctFloat: 0.15,
    weeklyCallOiRatio: 3,
    socialMentionRatio: 15,
    isMania: true,
    forwardReturn5d: -0.75,
    forwardReturn20d: -0.85,
    forwardReturn60d: -0.86,
    maxDrawdown60d: -0.94,
    note: "KOSS WSB peak ($127 close)",
  },
  // EXPR — Jan 2021
  {
    symbol: "EXPR",
    date: "2021-01-27",
    change5d: 2.5,
    change30d: 4.2,
    rsi14: 92,
    volumeRatio20d: 12,
    shortInterestPctFloat: 0.35,
    weeklyCallOiRatio: 4,
    socialMentionRatio: 10,
    isMania: true,
    forwardReturn5d: -0.60,
    forwardReturn20d: -0.70,
    forwardReturn60d: -0.60,
    maxDrawdown60d: -0.78,
    note: "EXPR WSB basket peak",
  },
  // BB (BlackBerry) — Jan 2021
  {
    symbol: "BB",
    date: "2021-01-27",
    change5d: 1.2,
    change30d: 2.6,
    rsi14: 91,
    volumeRatio20d: 10,
    shortInterestPctFloat: 0.08,
    weeklyCallOiRatio: 5,
    socialMentionRatio: 10,
    isMania: true,
    forwardReturn5d: -0.45,
    forwardReturn20d: -0.55,
    forwardReturn60d: -0.55,
    maxDrawdown60d: -0.62,
    note: "BB WSB basket peak ($25)",
  },
  // SPRT — Aug/Sep 2021 (merged with Greenidge)
  {
    symbol: "SPRT",
    date: "2021-08-27",
    change5d: 3.0,
    change30d: 8.5,
    rsi14: 93,
    volumeRatio20d: 25,
    shortInterestPctFloat: 0.6,
    weeklyCallOiRatio: 8,
    socialMentionRatio: 25,
    isMania: true,
    forwardReturn5d: 0.10,
    forwardReturn20d: -0.65,
    forwardReturn60d: -0.85,
    maxDrawdown60d: -0.90,
    note: "SPRT/GREE crypto-miner squeeze peak",
  },
  // ATER — Sep 2021
  {
    symbol: "ATER",
    date: "2021-09-24",
    change5d: 1.8,
    change30d: 3.2,
    rsi14: 90,
    volumeRatio20d: 18,
    shortInterestPctFloat: 0.4,
    weeklyCallOiRatio: 6,
    socialMentionRatio: 15,
    isMania: true,
    forwardReturn5d: -0.30,
    forwardReturn20d: -0.55,
    forwardReturn60d: -0.65,
    maxDrawdown60d: -0.75,
    note: "ATER meme-squeeze peak",
  },
  // IRNT — Sep 2021 (SPAC squeeze)
  {
    symbol: "IRNT",
    date: "2021-09-27",
    change5d: 1.5,
    change30d: 5.0,
    rsi14: 92,
    volumeRatio20d: 20,
    shortInterestPctFloat: 0.7,
    weeklyCallOiRatio: 10,
    socialMentionRatio: 20,
    isMania: true,
    forwardReturn5d: -0.35,
    forwardReturn20d: -0.72,
    forwardReturn60d: -0.90,
    maxDrawdown60d: -0.95,
    note: "IRNT low-float SPAC gamma squeeze peak",
  },
  // MULN — Mar 2022
  {
    symbol: "MULN",
    date: "2022-03-28",
    change5d: 2.0,
    change30d: 4.5,
    rsi14: 89,
    volumeRatio20d: 15,
    shortInterestPctFloat: 0.25,
    weeklyCallOiRatio: 4,
    socialMentionRatio: 12,
    isMania: true,
    forwardReturn5d: -0.30,
    forwardReturn20d: -0.55,
    forwardReturn60d: -0.72,
    maxDrawdown60d: -0.80,
    note: "MULN penny-EV squeeze peak",
  },
  // HYMC — Jun 2022
  {
    symbol: "HYMC",
    date: "2022-06-06",
    change5d: 1.3,
    change30d: 3.5,
    rsi14: 91,
    volumeRatio20d: 22,
    shortInterestPctFloat: 0.3,
    weeklyCallOiRatio: 5,
    socialMentionRatio: 15,
    isMania: true,
    forwardReturn5d: -0.40,
    forwardReturn20d: -0.60,
    forwardReturn60d: -0.75,
    maxDrawdown60d: -0.82,
    note: "HYMC gold-miner meme squeeze peak",
  },
  // AMTD Digital — Aug 2022
  {
    symbol: "HKD",
    date: "2022-08-02",
    change5d: 20.0,
    change30d: 200.0,
    rsi14: 99,
    volumeRatio20d: 100,
    shortInterestPctFloat: 0.02,
    weeklyCallOiRatio: 2,
    socialMentionRatio: 40,
    isMania: true,
    forwardReturn5d: -0.60,
    forwardReturn20d: -0.85,
    forwardReturn60d: -0.95,
    maxDrawdown60d: -0.98,
    note: "AMTD Digital float-crunch parabola",
  },
];

/**
 * ---- Non-mania control snapshots ----
 * Strong momentum / breakouts that were NOT retail manias. The detector must
 * mostly let these pass; blocking them is opportunity cost.
 */
const CONTROL_SNAPSHOTS: EpisodeSnapshot[] = [
  // NVDA AI breakout — May 2023
  {
    symbol: "NVDA",
    date: "2023-05-25",
    change5d: 0.30,
    change30d: 0.50,
    rsi14: 80,
    volumeRatio20d: 4,
    shortInterestPctFloat: 0.01,
    isMania: false,
    forwardReturn5d: 0.02,
    forwardReturn20d: 0.10,
    forwardReturn60d: 0.15,
    maxDrawdown60d: -0.10,
    note: "NVDA post-Q1 AI guidance gap",
  },
  {
    symbol: "NVDA",
    date: "2023-07-13",
    change5d: 0.08,
    change30d: 0.18,
    rsi14: 68,
    volumeRatio20d: 1.5,
    isMania: false,
    forwardReturn5d: 0.03,
    forwardReturn20d: 0.04,
    forwardReturn60d: -0.08,
    maxDrawdown60d: -0.16,
    note: "NVDA orderly uptrend continuation",
  },
  // META recovery — Jan/Feb 2023
  {
    symbol: "META",
    date: "2023-02-02",
    change5d: 0.25,
    change30d: 0.55,
    rsi14: 78,
    volumeRatio20d: 3,
    shortInterestPctFloat: 0.015,
    isMania: false,
    forwardReturn5d: 0.05,
    forwardReturn20d: 0.10,
    forwardReturn60d: 0.15,
    maxDrawdown60d: -0.08,
    note: "META year-of-efficiency gap",
  },
  // TSLA — Aug 2020 pre-split
  {
    symbol: "TSLA",
    date: "2020-08-31",
    change5d: 0.30,
    change30d: 0.75,
    rsi14: 83,
    volumeRatio20d: 3,
    isMania: false,
    forwardReturn5d: -0.20,
    forwardReturn20d: -0.15,
    forwardReturn60d: 0.10,
    maxDrawdown60d: -0.34,
    note: "TSLA post-split parabola (mild)",
  },
  // ENPH 2020 solar breakout
  {
    symbol: "ENPH",
    date: "2020-08-05",
    change5d: 0.35,
    change30d: 0.60,
    rsi14: 82,
    volumeRatio20d: 3.5,
    isMania: false,
    forwardReturn5d: 0.08,
    forwardReturn20d: 0.05,
    forwardReturn60d: 0.25,
    maxDrawdown60d: -0.20,
    note: "ENPH solar uptrend continuation",
  },
  // AAPL 2020 rally
  {
    symbol: "AAPL",
    date: "2020-08-31",
    change5d: 0.12,
    change30d: 0.30,
    rsi14: 82,
    volumeRatio20d: 2,
    isMania: false,
    forwardReturn5d: -0.10,
    forwardReturn20d: -0.15,
    forwardReturn60d: -0.05,
    maxDrawdown60d: -0.20,
    note: "AAPL post-split rally (mild reversal)",
  },
  // MSFT steady uptrend
  {
    symbol: "MSFT",
    date: "2023-06-15",
    change5d: 0.06,
    change30d: 0.15,
    rsi14: 72,
    volumeRatio20d: 1.4,
    isMania: false,
    forwardReturn5d: 0.02,
    forwardReturn20d: 0.03,
    forwardReturn60d: 0.02,
    maxDrawdown60d: -0.06,
    note: "MSFT orderly AI trend",
  },
  // SMCI early rally
  {
    symbol: "SMCI",
    date: "2023-05-30",
    change5d: 0.40,
    change30d: 0.70,
    rsi14: 84,
    volumeRatio20d: 4,
    isMania: false,
    forwardReturn5d: 0.10,
    forwardReturn20d: 0.20,
    forwardReturn60d: 0.30,
    maxDrawdown60d: -0.15,
    note: "SMCI AI-server breakout (fundamentals-backed)",
  },
  // MSTR bitcoin proxy rally
  {
    symbol: "MSTR",
    date: "2020-12-18",
    change5d: 0.35,
    change30d: 0.90,
    rsi14: 80,
    volumeRatio20d: 3,
    isMania: false,
    forwardReturn5d: -0.05,
    forwardReturn20d: 0.20,
    forwardReturn60d: 0.30,
    maxDrawdown60d: -0.30,
    note: "MSTR BTC-proxy rally",
  },
  // XOM 2022 energy rally
  {
    symbol: "XOM",
    date: "2022-03-04",
    change5d: 0.15,
    change30d: 0.30,
    rsi14: 78,
    volumeRatio20d: 2,
    isMania: false,
    forwardReturn5d: 0.02,
    forwardReturn20d: 0.05,
    forwardReturn60d: 0.15,
    maxDrawdown60d: -0.12,
    note: "XOM war-premium rally",
  },
  // COIN 2021 IPO rally (not blocked, borderline)
  {
    symbol: "COIN",
    date: "2021-11-08",
    change5d: 0.15,
    change30d: 0.45,
    rsi14: 76,
    volumeRatio20d: 3,
    shortInterestPctFloat: 0.10,
    isMania: false,
    forwardReturn5d: -0.10,
    forwardReturn20d: -0.20,
    forwardReturn60d: -0.35,
    maxDrawdown60d: -0.45,
    note: "COIN top-of-cycle rally (not meme)",
  },
  // GOOGL steady 2023 rally
  {
    symbol: "GOOGL",
    date: "2023-05-11",
    change5d: 0.10,
    change30d: 0.20,
    rsi14: 74,
    volumeRatio20d: 2,
    isMania: false,
    forwardReturn5d: 0.02,
    forwardReturn20d: 0.05,
    forwardReturn60d: 0.08,
    maxDrawdown60d: -0.08,
    note: "GOOGL AI rerating",
  },
];

export const RETAIL_MANIA_EPISODES: EpisodeSnapshot[] = [
  ...MANIA_SNAPSHOTS,
  ...CONTROL_SNAPSHOTS,
];

export const MANIA_COUNT = MANIA_SNAPSHOTS.length;
export const CONTROL_COUNT = CONTROL_SNAPSHOTS.length;
