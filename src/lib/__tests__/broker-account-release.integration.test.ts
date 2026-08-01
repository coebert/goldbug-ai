// Integration test: deactivating a portfolio RELEASES its broker-account claim.
//
// The exclusivity guard is deliberately strict — one Saxo account, one
// portfolio — but strictness without a release path is a trap: deactivating
// used to flip `mode` to "paper" while leaving `broker_account_id` set, so the
// account stayed locked to a portfolio that no longer traded it and no other
// portfolio could ever link it ("already linked to …" forever).
//
// This harness runs the REAL guard (`assertBrokerAccountUnclaimed`) and the
// REAL deactivation patch (`releaseBrokerAccountPatch`) against an in-memory
// portfolios table enforcing the same partial unique index as the database.

import { describe, it, expect, beforeEach } from "vitest";
import {
  assertBrokerAccountUnclaimed,
  releaseBrokerAccountPatch,
  type ClaimQueryClient,
} from "@/lib/broker-account-claim";
import { detectMirroredPortfolios } from "@/lib/portfolio-mirror-detect";

type Row = {
  id: string;
  name: string;
  broker: string | null;
  broker_account_id: string | null;
  mode: string;
  live_paused: boolean;
};

const ACCOUNT = "IszXddWLvI--FLMt59JcDA==";

class PortfoliosTable {
  rows: Row[] = [];

  reset() {
    this.rows = [
      { id: "p-high", name: "High risk sim portfolio", broker: null, broker_account_id: null, mode: "paper", live_paused: false },
      { id: "p-crypto", name: "Crypto Sim", broker: null, broker_account_id: null, mode: "paper", live_paused: false },
      { id: "p-balanced", name: "Balanced Sim", broker: null, broker_account_id: null, mode: "paper", live_paused: false },
    ];
  }

  row(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new Error("Portfolio not found");
    return r;
  }

  /** Mirrors `portfolios_unique_broker_account` (non-null ids only). */
  private enforceUnique(row: Row) {
    if (!row.broker_account_id) return;
    const clash = this.rows.some(
      (r) => r.id !== row.id && r.broker === row.broker && r.broker_account_id === row.broker_account_id,
    );
    if (clash) {
      throw Object.assign(
        new Error('duplicate key value violates unique constraint "portfolios_unique_broker_account"'),
        { code: "23505" },
      );
    }
  }

  update(id: string, patch: Partial<Row>) {
    const row = this.row(id);
    const next = { ...row, ...patch };
    this.enforceUnique(next);
    Object.assign(row, next);
  }

  client(): ClaimQueryClient {
    return {
      from: () => ({
        select: () => ({
          eq: (_c1: string, broker: string) => ({
            eq: (_c2: string, accountId: string) => ({
              neq: (_c3: string, excludeId: string) =>
                Promise.resolve({
                  data: this.rows
                    .filter(
                      (r) =>
                        r.broker === broker &&
                        r.broker_account_id === accountId &&
                        r.id !== excludeId,
                    )
                    .map((r) => ({ id: r.id, name: r.name })),
                  error: null,
                }),
            }),
          }),
        }),
      }),
    };
  }
}

/** activateLive: guard, then the indexed write. */
async function activate(table: PortfoliosTable, portfolioId: string, accountId: string) {
  await assertBrokerAccountUnclaimed(table.client(), {
    portfolioId,
    broker: "saxo",
    brokerAccountId: accountId,
  });
  table.update(portfolioId, { broker: "saxo", broker_account_id: accountId, mode: "live_sim" });
}

/** deactivateLive: idempotent no-op on paper, otherwise the release patch. */
function deactivate(table: PortfoliosTable, portfolioId: string) {
  const row = table.row(portfolioId);
  if (row.mode === "paper" || row.mode === "backtest") return { changed: false, released: null };
  const released = row.broker_account_id;
  table.update(portfolioId, releaseBrokerAccountPatch());
  return { changed: true, released };
}

describe("deactivation releases the broker-account claim", () => {
  const table = new PortfoliosTable();
  beforeEach(() => table.reset());

  it("clears broker_account_id and returns the portfolio to paper", async () => {
    await activate(table, "p-high", ACCOUNT);
    const result = deactivate(table, "p-high");

    expect(result).toEqual({ changed: true, released: ACCOUNT });
    expect(table.row("p-high")).toMatchObject({
      mode: "paper",
      live_paused: false,
      broker_account_id: null,
    });
  });

  it("lets a DIFFERENT portfolio claim the account afterwards", async () => {
    await activate(table, "p-high", ACCOUNT);
    await expect(activate(table, "p-crypto", ACCOUNT)).rejects.toThrow(/already linked/);

    deactivate(table, "p-high");

    await expect(activate(table, "p-crypto", ACCOUNT)).resolves.toBeUndefined();
    expect(table.row("p-crypto")).toMatchObject({ broker_account_id: ACCOUNT, mode: "live_sim" });
    expect(table.rows.filter((r) => r.broker_account_id === ACCOUNT)).toHaveLength(1);
  });

  it("survives a full hand-off round trip between three portfolios", async () => {
    for (const id of ["p-high", "p-crypto", "p-balanced"]) {
      await activate(table, id, ACCOUNT);
      expect(table.rows.filter((r) => r.broker_account_id === ACCOUNT).map((r) => r.id)).toEqual([id]);
      deactivate(table, id);
    }
    expect(table.rows.every((r) => r.broker_account_id === null)).toBe(true);
  });

  it("only one claimant can win after a release, even racing", async () => {
    await activate(table, "p-high", ACCOUNT);
    deactivate(table, "p-high");

    const results = await Promise.allSettled([
      activate(table, "p-crypto", ACCOUNT),
      activate(table, "p-balanced", ACCOUNT),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(table.rows.filter((r) => r.broker_account_id === ACCOUNT)).toHaveLength(1);
  });

  it("is idempotent: deactivating an already-paper portfolio changes nothing", () => {
    const before = JSON.stringify(table.rows);
    expect(deactivate(table, "p-crypto")).toEqual({ changed: false, released: null });
    expect(JSON.stringify(table.rows)).toBe(before);
  });

  it("does not disturb another portfolio's live claim", async () => {
    await activate(table, "p-high", ACCOUNT);
    await activate(table, "p-crypto", "GTFB25I1ficWMb4bgW3MRQ==");

    deactivate(table, "p-high");

    expect(table.row("p-crypto")).toMatchObject({
      mode: "live_sim",
      broker_account_id: "GTFB25I1ficWMb4bgW3MRQ==",
    });
  });

  it("leaves no mirrored books after a hand-off", async () => {
    await activate(table, "p-high", ACCOUNT);
    deactivate(table, "p-high");
    await activate(table, "p-crypto", ACCOUNT);

    const findings = detectMirroredPortfolios(
      table.rows.map((r) => ({
        id: r.id,
        name: r.name,
        broker: r.broker,
        broker_account_id: r.broker_account_id,
        mode: r.mode,
      })) as never,
    );
    expect(findings).toHaveLength(0);
  });
});
