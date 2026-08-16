// Thesis-break exit replay on REAL evidence tapes.
//
//   bun run scripts/run-thesis-break-real-tape.ts
//   bun run scripts/run-thesis-break-real-tape.ts --symbols AAPL,MKS.L --from 2026-05-01
//
// Unlike run-thesis-break-backtest.ts (price-derived proxies), this run feeds
// `evaluateThesisBreak` the same external streams the live engine reads:
//   news score/momentum → cached headlines with LLM sentiment (news_cache)
//   insider nudge       → filed director dealings (Yahoo insiderTransactions)
//   fundamentals        → published-accounts score (Yahoo quoteSummary)
// Trend and failed-breakout stay price facts.
//
// The headline archive only reaches back to 2026-05-01, so that is the
// default evidence window; prices are loaded further back for SMA warm-up.

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { loadRealEvidenceTape } from "../src/lib/backtest/thesis-break-evidence.server";
import type { EvidenceNewsRow } from "../src/lib/backtest/thesis-break-evidence";
import {
  replayArm,
  splitFiringsByHistory,
  type ArmResult,
  type ReplayTape,
} from "../src/lib/backtest/thesis-break-replay";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const DEFAULT = ["AAPL", "MKS.L", "MSFT", "NVDA", "JPM", "TSCO.L", "BP.L", "TSLA", "BARC.L", "AZN.L"];
const evidenceFrom = arg("from", "2026-05-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const priceFrom = arg("price-from", "2025-09-01"); // SMA20/50 warm-up
const symbols = arg("symbols", DEFAULT.join(",")).split(",").map((s) => s.trim().toUpperCase());

const pad = (s: string | number, n: number) => String(s).padStart(n);

// --- news archive -----------------------------------------------------------
type NewsQueryRow = { news_date: string; headline: string; summary: string | null; sentiment: string | null };

async function loadNews(from: string, until: string): Promise<EvidenceNewsRow[]> {
  const sql =
    `select news_date, headline, summary, sentiment from news_cache ` +
    `where news_date >= '${from}' and news_date <= '${until}' and sentiment is not null ` +
    `order by news_date`;
  const proc = Bun.spawn(["lovable", "supabase", "query", sql, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`news query failed: ${await new Response(proc.stderr).text()}`);
  }
  const parsed = JSON.parse(out) as { rows?: NewsQueryRow[] };
  return (parsed.rows ?? []).map((r) => ({
    headline: r.headline ?? "",
    summary: r.summary,
    sentiment: r.sentiment,
    date: (r.news_date ?? "").slice(0, 10) || null,
  }));
}

// --- price tape -------------------------------------------------------------
const histories = await fetchUniverseHistory(symbols, { from: priceFrom, to });
const tape: ReplayTape = {};
for (const h of histories) {
  const bars = h.bars
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .map((b) => ({ date: b.date, close: (b.adjClose ?? b.close) as number }));
  if (bars.length > 60) tape[h.symbol] = bars;
}
const loaded = Object.keys(tape);
const dates = [...new Set(loaded.flatMap((s) => tape[s]!.map((b) => b.date)))].sort();
console.log(`Price tape: ${loaded.length} symbols (${loaded.join(", ")})  ${priceFrom} → ${to}`);

// --- evidence tape ----------------------------------------------------------
const news = await loadNews(evidenceFrom, to);
const evidence = await loadRealEvidenceTape({ symbols: loaded, dates, news, asOf: to });
console.log(
  `Evidence tape: ${news.length} scored headlines in archive, ` +
    `${evidence.coverage.newsRowsMatched} matched to universe symbols, ` +
    `${evidence.coverage.insiderEvents} filed dealings, ` +
    `${evidence.coverage.fundamentalsSymbols}/${loaded.length} fundamentals scores ` +
    `(evidence window ${evidence.from ?? "-"} → ${evidence.to ?? "-"})\n`,
);

// Per-symbol coverage so a thin stream is visible rather than silent.
console.log("Per-symbol evidence coverage:");
console.log([pad("Symbol", 8), pad("news days", 10), pad("insider days", 13), pad("fund", 7)].join(" "));
for (const sym of loaded) {
  const per = evidence.bySymbol.get(sym);
  let newsDays = 0;
  let insiderDays = 0;
  let fund: number | null = null;
  for (const e of per?.values() ?? []) {
    if (e.newsScore != null) newsDays += 1;
    if (e.insiderNudge != null) insiderDays += 1;
    fund = e.fundamentalsScore;
  }
  console.log(
    [pad(sym, 8), pad(newsDays, 10), pad(insiderDays, 13), pad(fund == null ? "-" : fund.toFixed(2), 7)].join(" "),
  );
}

// --- two arms ---------------------------------------------------------------
const base = replayArm(tape, { thesisBreak: false });
const tb = replayArm(tape, { thesisBreak: true, evidence });
const proxy = replayArm(tape, { thesisBreak: true }); // old price-proxy arm, for contrast
const firing = splitFiringsByHistory(tb.trades);

const row = (m: ArmResult, label: string) =>
  [
    pad(label, 18),
    pad(m.totalReturnPct.toFixed(2), 9),
    pad(m.maxDrawdownPct.toFixed(2), 9),
    pad(m.winRatePct.toFixed(1), 7),
    pad(m.avgLossPct.toFixed(2), 9),
    pad(m.trades.length, 7),
  ].join(" ");

console.log(
  "\n" +
    [pad("Arm", 18), pad("Ret%", 9), pad("MaxDD%", 9), pad("Win%", 7), pad("AvgLoss%", 9), pad("Trades", 7)].join(" "),
);
console.log("-".repeat(63));
console.log(row(base, "stop-only"));
console.log(row(tb, "thesis (real)"));
console.log(row(proxy, "thesis (proxy)"));

console.log("\nExit mix (real-evidence arm):");
for (const [k, v] of Object.entries(tb.exitMix).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pad(k, 22)} ${pad(v, 4)}`);
}

console.log("\nThesis-break firings by symbol loss history (real evidence):");
console.log(
  `  first loss:   ${firing.firstLoss} of ${firing.firstLossOpportunities} losing trades ` +
    `(${firing.firstLossFireRatePct.toFixed(1)}%)`,
);
console.log(
  `  repeat loser: ${firing.repeatLoser} of ${firing.repeatOpportunities} losing trades ` +
    `(${firing.repeatFireRatePct.toFixed(1)}%)`,
);

const fires = tb.trades.filter((t) => t.thesisBreak).sort((a, b) => a.exitDate.localeCompare(b.exitDate));
console.log(`\nEvery real-evidence thesis-break cut (${fires.length}):`);
console.log([pad("Symbol", 8), pad("Entry", 11), pad("Exit", 11), pad("Ret%", 8), pad("Prior", 6), "Signals"].join(" "));
for (const t of fires.slice(0, 40)) {
  console.log(
    [
      pad(t.symbol, 8),
      pad(t.entryDate, 11),
      pad(t.exitDate, 11),
      pad((t.returnPct * 100).toFixed(2), 8),
      pad(t.priorLosses, 6),
      t.signals.join("; "),
    ].join(" "),
  );
}
