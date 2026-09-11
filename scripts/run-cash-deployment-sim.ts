// Cash-deployment sweep across every account.
//
//   bun run scripts/run-cash-deployment-sim.ts
//   bun run scripts/run-cash-deployment-sim.ts --from 2021-01-01 --rates 0.05,0.10,0.15,0.20,0.25,0.30,0.40
//
// One arm per (account, fixed deployment rate). The rate is the share of NAV
// each new position targets, which is what actually decides how much of the
// cash pile ends up invested. Everything else — signals, cost governor, fills,
// caps — is identical across arms, so the only difference is the rate.
//
// Reported per rate: total return, max drawdown, return per unit of drawdown
// (the balance metric), friction paid and average cash deployed.

import { fetchUniverseHistory } from "../src/lib/real-market-tape.server";
import { runGovernorReplay, type ArmOutcome, type ReplayBar } from "../src/lib/backtest/governor-replay";
import { assumptionsFromFlags } from "../src/lib/backtest/execution-assumptions";

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "JNJ", "XOM", "TSLA", "V",
  "SPY", "QQQ", "VUSA.L", "VWRL.L", "ISF.L", "ULVR.L", "TSCO.L",
];
const FOREIGN = ["AAPL", "MSFT", "NVDA", "JNJ", "XOM", "TSLA", "V", "SPY", "QQQ"];

type Account = { name: string; mode: string; currency: string; nav: number };

// NAV = cash + invested at cost, as read from the account table.
const ACCOUNTS: Account[] = [
  { name: "My Portfolio", mode: "live_prod", currency: "GBP", nav: 3283.18 + 7127.37 },
  { name: "Crypto Sim", mode: "paper", currency: "GBP", nav: 76388.89 + 25470.36 },
  { name: "High risk sim", mode: "backtest", currency: "GBP", nav: 20.24 + 902.36 },
  { name: "Balanced risk sim", mode: "live_sim", currency: "EUR", nav: 992119.02 + 214591.14 },
  { name: "High risk sim portfolio", mode: "live_sim", currency: "EUR", nav: 768755.2 + 281407.1 },
];

const from = arg("from", "2021-01-01");
const to = arg("to", new Date().toISOString().slice(0, 10));
const rates = arg("rates", "0.05,0.08,0.10,0.12,0.15,0.20,0.25,0.30,0.40")
  .split(",")
  .map((r) => Number(r.trim()))
  .filter((r) => Number.isFinite(r) && r > 0);
const assumptions = assumptionsFromFlags(argv);

const histories = await fetchUniverseHistory(SYMBOLS, { from, to });
const byDate = new Map<string, Record<string, number>>();
for (const h of histories) {
  for (const b of h.bars) {
    if (!Number.isFinite(b.close) || b.close <= 0) continue;
    const row = byDate.get(b.date) ?? {};
    row[h.symbol] = b.close;
    byDate.set(b.date, row);
  }
}
const bars: ReplayBar[] = Array.from(byDate.entries())
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([date, closes]) => ({ date, closes }));

console.log(`tape ${bars[0]?.date} → ${bars.at(-1)?.date}  (${bars.length} bars, ${SYMBOLS.length} symbols)`);

function deployedShare(o: ArmOutcome, nav: number): number {
  if (o.trades.length === 0) return 0;
  const held = o.trades.reduce((s, t) => s + t.notional, 0) / Math.max(1, o.trades.length);
  return (held / nav) * 100;
}

type Row = { rate: number; ret: number; dd: number; ratio: number; trades: number; friction: number; avgTicketPct: number };

const perAccount: Array<{ account: Account; rows: Row[] }> = [];

for (const account of ACCOUNTS) {
  const rows: Row[] = [];
  for (const rate of rates) {
    const out = runGovernorReplay(bars, "revised", {
      startingCash: account.nav,
      foreignSymbols: FOREIGN,
      sizing: "revised",
      targetWeightPct: rate,
      signal: "cross",
      assumptions,
      maxPositionPctOfNav: Math.max(0.2, rate),
      maxDiversifiedPositionPctOfNav: Math.max(0.35, rate),
    });
    rows.push({
      rate,
      ret: out.totalReturnPct,
      dd: out.maxDrawdownPct,
      ratio: out.maxDrawdownPct > 0.01 ? out.totalReturnPct / out.maxDrawdownPct : out.totalReturnPct,
      trades: out.trades.length,
      friction: out.frictionPaid,
      avgTicketPct: deployedShare(out, account.nav),
    });
  }
  perAccount.push({ account, rows });

  console.log(`\n=== ${account.name} (${account.mode}, ${account.currency} ${Math.round(account.nav).toLocaleString()}) ===`);
  console.log("rate    return    maxDD   return/DD  trades   friction   avg ticket %NAV");
  for (const r of rows) {
    console.log(
      [
        `${(r.rate * 100).toFixed(0)}%`.padEnd(7),
        `${r.ret.toFixed(2)}%`.padStart(8),
        `${r.dd.toFixed(2)}%`.padStart(8),
        r.ratio.toFixed(2).padStart(11),
        String(r.trades).padStart(7),
        r.friction.toFixed(0).padStart(10),
        `${r.avgTicketPct.toFixed(1)}%`.padStart(18),
      ].join(" "),
    );
  }
  const best = [...rows].sort((a, b) => b.ratio - a.ratio)[0]!;
  console.log(`best balance: ${(best.rate * 100).toFixed(0)}%  (${best.ret.toFixed(2)}% return, ${best.dd.toFixed(2)}% drawdown)`);
}

// Cross-account: average the return/drawdown ratio at each rate.
console.log("\n=== all accounts ===");
console.log("rate   avg return   avg maxDD   avg return/DD");
const agg = rates.map((rate) => {
  const rows = perAccount.map((p) => p.rows.find((r) => r.rate === rate)!);
  const mean = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  return { rate, ret: mean((r) => r.ret), dd: mean((r) => r.dd), ratio: mean((r) => r.ratio) };
});
for (const a of agg) {
  console.log(
    [`${(a.rate * 100).toFixed(0)}%`.padEnd(6), `${a.ret.toFixed(2)}%`.padStart(11), `${a.dd.toFixed(2)}%`.padStart(11), a.ratio.toFixed(2).padStart(15)].join(" "),
  );
}
const bestOverall = [...agg].sort((x, y) => y.ratio - x.ratio)[0]!;
console.log(
  `\nBest fixed deployment rate across all accounts: ${(bestOverall.rate * 100).toFixed(0)}% per position ` +
    `— avg return ${bestOverall.ret.toFixed(2)}%, avg drawdown ${bestOverall.dd.toFixed(2)}%.`,
);
