// Integration test: parallel sync + reconcile of two portfolios where one is
// linked to a broker account and the other has no `broker_account_id`.
//
// This is the regression harness for the mirroring bug: a sync path that falls
// back to a process-wide default account key writes one broker snapshot into
// EVERY portfolio, so an unlinked sim portfolio silently inherits the linked
// account's holdings, cash and equity.
//
// The harness runs the real link resolver (`resolvePortfolioBrokerLink`), the
// real post-broker reconciliation (`reconcileBuysWithFxLegs`) and the real
// mirror detector (`detectMirroredPortfolios`) against an in-memory ledger,
// with both portfolios syncing concurrently and interleaving their awaits.

import { describe, it, expect, beforeEach } from "vitest";
import { resolvePortfolioBrokerLink } from "@/lib/brokers/portfolio-broker-link.server";
import { reconcileBuysWithFxLegs, type RoutedBuy } from "@/lib/post-broker-reconciliation";
import { detectMirroredPortfolios } from "@/lib/portfolio-mirror-detect";

// ---------------------------------------------------------------- fixtures

type Holding = { symbol: string; quantity: number; avg_cost: number };

type Ledger = {
  id: string;
  name: string;
  risk_level: string;
  broker: string | null;
  broker_account_id: string | null;
  current_cash: number;
  holdings: Holding[];
  equity: number;
  /** Every skip/apply decision taken by the sync, for assertion. */
  log: string[];
};

/** The one real broker account. Its snapshot must never leak elsewhere. */
const BROKER_SNAPSHOT = {
  cash: 7421.55,
  holdings: [
    { symbol: "AAPL", quantity: 12, avg_cost: 190.25 },
    { symbol: "VUSA.L", quantity: 40, avg_cost: 78.4 },
  ] as Holding[],
};

/** The process-wide default that the buggy code path used to fall back to. */
const DEFAULT_ACCOUNT_KEY = "ACC-DEFAULT";
const LINKED_ACCOUNT_KEY = "ACC-LINKED-1";

function makeLedgers(): Record<string, Ledger> {
  return {
    linked: {
      id: "p-linked",
      name: "Live cash (Saxo)",
      risk_level: "balanced",
      broker: "saxo",
      broker_account_id: LINKED_ACCOUNT_KEY,
      current_cash: 500,
      holdings: [],
      equity: 500,
      log: [],
    },
    unlinked: {
      id: "p-unlinked",
      name: "High risk sim",
      risk_level: "high",
      broker: null,
      broker_account_id: null,
      current_cash: 10_300,
      holdings: [{ symbol: "MSFT", quantity: 5, avg_cost: 400 }],
      equity: 12_300,
      log: [],
    },
  };
}

// ------------------------------------------------------------- fake broker

/** Records every account key the adapter was constructed/queried with. */
class FakeBroker {
  calls: string[] = [];

  async snapshot(accountKey: string) {
    this.calls.push(accountKey);
    // Simulate wire latency so the two portfolio syncs genuinely interleave.
    await new Promise((r) => setTimeout(r, 5));
    if (accountKey !== LINKED_ACCOUNT_KEY) {
      throw new Error(`unexpected account key requested: ${accountKey}`);
    }
    return {
      cash: BROKER_SNAPSHOT.cash,
      holdings: BROKER_SNAPSHOT.holdings.map((h) => ({ ...h })),
    };
  }
}

// --------------------------------------------------------------- pipeline

const equityOf = (l: Ledger) =>
  l.current_cash + l.holdings.reduce((s, h) => s + h.quantity * h.avg_cost, 0);

/**
 * The production-shaped sync: resolve the link FIRST, and only touch the
 * broker (and only overwrite local state) when the portfolio owns a key.
 */
async function syncPortfolio(l: Ledger, broker: FakeBroker): Promise<void> {
  const link = resolvePortfolioBrokerLink(l);
  if (!link.linked) {
    l.log.push(`skip:${link.reason}`);
    l.equity = equityOf(l);
    return;
  }
  const snap = await broker.snapshot(link.accountKey);
  l.current_cash = snap.cash;
  l.holdings = snap.holdings;
  l.equity = equityOf(l);
  l.log.push(`applied:${link.accountKey}`);
}

/** Reconciliation pass over each portfolio's own routed buys. */
async function reconcilePortfolio(l: Ledger, buys: RoutedBuy[]) {
  await new Promise((r) => setTimeout(r, 2));
  return reconcileBuysWithFxLegs(buys, [], []).map((e) => ({ ...e, portfolioId: l.id }));
}

async function syncAndReconcile(l: Ledger, broker: FakeBroker, buys: RoutedBuy[]) {
  await syncPortfolio(l, broker);
  return reconcilePortfolio(l, buys);
}

// ------------------------------------------------------------------ tests

describe("parallel sync + reconcile: linked vs unlinked portfolio", () => {
  let ledgers: Record<string, Ledger>;
  let broker: FakeBroker;

  beforeEach(() => {
    ledgers = makeLedgers();
    broker = new FakeBroker();
  });

  const runBoth = () =>
    Promise.all([
      syncAndReconcile(ledgers.linked, broker, [{ symbol: "AAPL", side: "buy", status: "filled" }]),
      syncAndReconcile(ledgers.unlinked, broker, [{ symbol: "MSFT", side: "buy", status: "filled" }]),
    ]);

  it("only queries the broker with the linked portfolio's own account key", async () => {
    await runBoth();
    expect(broker.calls).toEqual([LINKED_ACCOUNT_KEY]);
    expect(broker.calls).not.toContain(DEFAULT_ACCOUNT_KEY);
  });

  it("never writes broker holdings into the unlinked portfolio", async () => {
    await runBoth();
    expect(ledgers.unlinked.holdings).toEqual([{ symbol: "MSFT", quantity: 5, avg_cost: 400 }]);
    const brokerSymbols = BROKER_SNAPSHOT.holdings.map((h) => h.symbol);
    for (const sym of brokerSymbols) {
      expect(ledgers.unlinked.holdings.map((h) => h.symbol)).not.toContain(sym);
    }
    expect(ledgers.linked.holdings.map((h) => h.symbol).sort()).toEqual(brokerSymbols.sort());
  });

  it("keeps cash and equity separate across the two books", async () => {
    await runBoth();
    expect(ledgers.linked.current_cash).toBe(BROKER_SNAPSHOT.cash);
    expect(ledgers.unlinked.current_cash).toBe(10_300);
    expect(ledgers.linked.equity).not.toBe(ledgers.unlinked.equity);
    expect(ledgers.unlinked.equity).toBe(10_300 + 5 * 400);
  });

  it("logs an explicit refusal for the portfolio with no broker_account_id", async () => {
    await runBoth();
    expect(ledgers.unlinked.log).toEqual([
      "skip:portfolio is not linked to a broker (simulated ledger)",
    ]);
    expect(ledgers.linked.log).toEqual([`applied:${LINKED_ACCOUNT_KEY}`]);
  });

  it("refuses the default-account fallback even when broker='saxo' but the id is blank", async () => {
    ledgers.unlinked.broker = "saxo";
    ledgers.unlinked.broker_account_id = "   ";
    await runBoth();
    expect(broker.calls).toEqual([LINKED_ACCOUNT_KEY]);
    expect(ledgers.unlinked.log[0]).toContain("refusing to fall back to the default account");
    expect(ledgers.unlinked.current_cash).toBe(10_300);
  });

  it("scopes reconciliation entries to their own portfolio", async () => {
    const [linkedRecon, unlinkedRecon] = await runBoth();
    expect(linkedRecon.map((e) => e.portfolioId)).toEqual(["p-linked"]);
    expect(unlinkedRecon.map((e) => e.portfolioId)).toEqual(["p-unlinked"]);
    expect(linkedRecon[0].symbol).toBe("AAPL");
    expect(unlinkedRecon[0].symbol).toBe("MSFT");
    expect(linkedRecon.every((e) => e.status === "fully_funded")).toBe(true);
  });

  it("produces no mirror findings after a parallel sync", async () => {
    await runBoth();
    const findings = detectMirroredPortfolios([ledgers.linked, ledgers.unlinked]);
    expect(findings).toEqual([]);
  });

  it("stays clean when the same pair syncs repeatedly and concurrently", async () => {
    for (let i = 0; i < 5; i++) await runBoth();
    expect(broker.calls).toEqual(Array(5).fill(LINKED_ACCOUNT_KEY));
    expect(ledgers.unlinked.current_cash).toBe(10_300);
    expect(ledgers.unlinked.holdings).toHaveLength(1);
    expect(detectMirroredPortfolios([ledgers.linked, ledgers.unlinked])).toEqual([]);
  });

  it("is order-independent: reversing the concurrent start order changes nothing", async () => {
    const forward = makeLedgers();
    const reverse = makeLedgers();
    const b1 = new FakeBroker();
    const b2 = new FakeBroker();
    await Promise.all([syncPortfolio(forward.linked, b1), syncPortfolio(forward.unlinked, b1)]);
    await Promise.all([syncPortfolio(reverse.unlinked, b2), syncPortfolio(reverse.linked, b2)]);
    expect(reverse.linked.holdings).toEqual(forward.linked.holdings);
    expect(reverse.unlinked.holdings).toEqual(forward.unlinked.holdings);
    expect(reverse.unlinked.equity).toBe(forward.unlinked.equity);
    expect(reverse.linked.equity).toBe(forward.linked.equity);
  });

  it("catches the regression: a default-account fallback mirrors both books", async () => {
    // Simulate the OLD buggy sync — resolve to the env default when unlinked.
    const buggySync = async (l: Ledger) => {
      const link = resolvePortfolioBrokerLink(l);
      const key = link.linked ? link.accountKey : DEFAULT_ACCOUNT_KEY;
      const snap =
        key === DEFAULT_ACCOUNT_KEY
          ? { cash: BROKER_SNAPSHOT.cash, holdings: BROKER_SNAPSHOT.holdings.map((h) => ({ ...h })) }
          : await broker.snapshot(key);
      l.current_cash = snap.cash;
      l.holdings = snap.holdings;
      l.equity = equityOf(l);
    };
    await Promise.all([buggySync(ledgers.linked), buggySync(ledgers.unlinked)]);

    const findings = detectMirroredPortfolios([ledgers.linked, ledgers.unlinked]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].cause).toBe("linked_and_unlinked_mismatch");
  });
});
