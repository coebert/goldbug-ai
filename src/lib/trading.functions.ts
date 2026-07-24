// Backwards-compatibility barrel: after Phase 3 all implementations were
// extracted into dedicated modules. New code should import directly from
// the target files listed below.

export { getCurrentRegime, getRegimeHistory, refreshRegimeNow } from "./regime.functions";
export {
  getPortfolioLearning,
  listLessonOverrides,
  setLessonOverride,
  clearLessonOverride,
  rateLessonFeedback,
} from "./lessons.functions";
export { getBenchmarkSeries } from "./benchmark.functions";
export { getGlobalNewsReel, getDecisionNewsBreakdown } from "./news.functions";
export { triggerHourlyRunNow } from "./hourly-run.functions";
export { getPerformanceReport, getComparison, getTradeComparison } from "./reports.functions";
export { getDiagnostics } from "./diagnostics.functions";
export { runBacktest, runBacktestMany, runLongHorizonBacktest } from "./backtest.functions";
export { addSimFunds, listSimFundEvents } from "./sim-funds.functions";
export { addSimFundsHandler } from "./sim-funds.server";
export {
  createPortfolio,
  listPortfolios,
  getAllPortfoliosEquity,
  getPortfolio,
  deletePortfolio,
  renamePortfolio,
} from "./portfolios.functions";
export { updateRiskConfig, calibrateExecution, resetPortfolio, runOneDay } from "./risk.functions";
export { getDivergenceNarratives } from "./divergence.functions";
export { runPortfolioOptimizer } from "./optimizer.functions";
