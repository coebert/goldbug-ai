// Integration test: a broker account can be claimed by at most ONE portfolio.
//
// Regression harness for the mirror bug where two portfolios were bound to the
// same Saxo account key and from then on reported identical holdings/equity.
//
// The harness runs the REAL activation guard (`assertBrokerAccountUnclaimed`)
// and the REAL mirror detector against an in-memory `portfolios` table that
// enforces the same partial unique index as the database
// (`portfolios_unique_broker_account ON (broker, broker_account_id)
//   WHERE broker_account_id IS NOT NULL`).

import { describe, it, expect, beforeEach } from "vitest";
import {
  assertBrokerAccountUnclaimed,
  isBrokerAccountUniqueViolation,
  type ClaimQueryClient,
} from "@/lib/broker-account-claim";
import { detectMirroredPortfolios } from "@/lib/portfolio-mirror-detect";

type Row = {
  id: string;
  name: string;
  broker: string | null;
  broker_account_id: string | null;
  mode: string;
};

const ACCOUNT = "IszXddWLvI--FLMt59JcDA==";

class PortfoliosTable {
  rows: Row[] = [];

  reset() {
    this.rows = [
      { id: "p-high", name: "High risk sim portfolio", broker: null, broker_account_id: null, mode: "paper" },
      { id: "p-crypto", name: "Crypto Sim", broker: null, broker_account_id: null, mode: "paper" },
    ];
  }

  /** Mirrors the DB partial unique index. */
  private enforceUnique(row: Row) {
    if (!row.broker_account_id) return;
    const clash = this.rows.some(
      (r) => r.id !== row.id && r.broker === row.broker && r.broker_account_id === row.broker_account_id,
    );
    if (clash) {
      throw Object.assign(
        new Error(
          'duplicate key value violates unique constraint "portfolios_unique_broker_account"',
        ),
        { code: "23505" },
      );
    }
  }

  /** The write half of activateLive, index enforcement included. */
  link(portfolioId: string, broker: string, accountId: string) {
    const row = this.rows.find((r) => r.id === portfolioId);
    if (!row) throw new Error("Portfolio not found");
    const next = { ...row, broker, broker_account_id: accountId, mode: "live_sim" };
    this.enforceUnique(next);
    Object.assign(row, next);
  }

  /** Just enough of the PostgREST builder for the guard. */
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

/** The full activation path: guard, then the indexed write. */
async function activate(table: PortfoliosTable, portfolioId: string, accountId: string) {
  await assertBrokerAccountUnclaimed(table.client(), {
    portfolioId,
    broker: "saxo",
    brokerAccountId: accountId,
  });
  table.link(portfolioId, "saxo", accountId);
}

describe("broker account exclusivity", () => {
  const table = new PortfoliosTable();
  beforeEach(() => table.reset());

  it("lets the first portfolio claim a free account", async () => {
    await activate(table, "p-high", ACCOUNT);
    expect(table.rows.find((r) => r.id === "p-high")).toMatchObject({
      broker: "saxo",
      broker_account_id: ACCOUNT,
      mode: "live_sim",
    });
  });

  it("rejects a second portfolio claiming the same account, with a readable message", async () => {
    await activate(table, "p-high", ACCOUNT);
    await expect(activate(table, "p-crypto", ACCOUNT)).rejects.toThrow(
      /already linked to "High risk sim portfolio"/,
    );
    // The loser must stay unlinked — no partial write.
    expect(table.rows.find((r) => r.id === "p-crypto")).toMatchObject({
      broker: null,
      broker_account_id: null,
      mode: "paper",
    });
  });

  it("is idempotent: re-activating the same portfolio on its own account succeeds", async () => {
    await activate(table, "p-high", ACCOUNT);
    await expect(activate(table, "p-high", ACCOUNT)).resolves.toBeUndefined();
    expect(table.rows.filter((r) => r.broker_account_id === ACCOUNT)).toHaveLength(1);
  });

  it("allows distinct accounts on distinct portfolios", async () => {
    await activate(table, "p-high", ACCOUNT);
    await activate(table, "p-crypto", "GTFB25I1ficWMb4bgW3MRQ==");
    expect(new Set(table.rows.map((r) => r.broker_account_id)).size).toBe(2);
  });

  it("does not constrain unlinked (paper) portfolios", async () => {
    await expect(
      assertBrokerAccountUnclaimed(table.client(), {
        portfolioId: "p-crypto",
        broker: "saxo",
        brokerAccountId: null,
      }),
    ).resolves.toBeUndefined();
    expect(table.rows.every((r) => r.broker_account_id === null)).toBe(true);
  });

  it("the unique index catches a concurrent claim that slips past the pre-check", async () => {
    // Both guards observe a free account (classic TOCTOU), then both write.
    await Promise.all([
      assertBrokerAccountUnclaimed(table.client(), {
        portfolioId: "p-high",
        broker: "saxo",
        brokerAccountId: ACCOUNT,
      }),
      assertBrokerAccountUnclaimed(table.client(), {
        portfolioId: "p-crypto",
        broker: "saxo",
        brokerAccountId: ACCOUNT,
      }),
    ]);

    table.link("p-high", "saxo", ACCOUNT);
    let caught: unknown;
    try {
      table.link("p-crypto", "saxo", ACCOUNT);
    } catch (e) {
      caught = e;
    }
    expect(isBrokerAccountUniqueViolation(caught)).toBe(true);
    expect(table.rows.filter((r) => r.broker_account_id === ACCOUNT)).toHaveLength(1);
  });

  it("no mirror finding is produced once accounts are exclusive", async () => {
    await activate(table, "p-high", ACCOUNT);
    await activate(table, "p-crypto", "GTFB25I1ficWMb4bgW3MRQ==");

    const findings = detectMirroredPortfolios([
      {
        id: "p-high",
        name: "High risk sim portfolio",
        broker: "saxo",
        brokerAccountId: ACCOUNT,
        equity: 16982.73,
        cash: 16982.73,
        holdings: [{ symbol: "ULVR:xlon", quantity: 100 }],
      },
      {
        id: "p-crypto",
        name: "Crypto Sim",
        broker: "saxo",
        brokerAccountId: "GTFB25I1ficWMb4bgW3MRQ==",
        equity: 100000,
        cash: 100000,
        holdings: [],
      },
    ]);
    expect(findings).toHaveLength(0);
  });
});
