import { describe, it, expect } from "vitest";
import {
  deletePortfolioWithCleanup,
  PORTFOLIO_NOT_FOUND_MESSAGE,
  type DeletableRow,
  type DeleteQueryClient,
} from "@/lib/portfolio-delete-cleanup";
import {
  assertBrokerAccountUnclaimed,
  type ClaimQueryClient,
} from "@/lib/broker-account-claim";

/**
 * Tiny in-memory `portfolios` table that enforces the same partial unique index
 * as the database (`portfolios_unique_broker_account`).
 */
function makeDb(rows: DeletableRow[], opts: { deleteFails?: string; hideOnDelete?: boolean } = {}) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));

  function assertUnique(id: string, broker: string | null, account: string | null) {
    if (!account) return;
    for (const [otherId, r] of table) {
      if (otherId !== id && r.broker === broker && r.broker_account_id === account) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        });
      }
    }
  }

  const client = {
    from() {
      return {
        select(_columns: string) {
          return {
            eq(_c: string, id: string) {
              return {
                maybeSingle: async () => ({ data: table.get(id) ?? null, error: null }),
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: async (_c: string, id: string) => {
              const row = table.get(id);
              if (!row) return { data: null, error: null };
              const next = { ...row, ...patch } as DeletableRow;
              assertUnique(id, next.broker, next.broker_account_id);
              table.set(id, next);
              return { data: null, error: null };
            },
          };
        },
        delete() {
          return {
            eq(_c: string, id: string) {
              return {
                select: async (_cols: string) => {
                  if (opts.deleteFails) {
                    return { data: null, error: { message: opts.deleteFails } };
                  }
                  // RLS-style silent no-op: nothing matched, but no error either.
                  if (opts.hideOnDelete) return { data: [], error: null };
                  const existed = table.delete(id);
                  return { data: existed ? [{ id }] : [], error: null };
                },
              };
            },
          };
        },
      };
    },
  };

  // Claim pre-check view over the same table (select → eq → eq → neq).
  const claimClient: ClaimQueryClient = {
    from() {
      return {
        select() {
          return {
            eq(_c1: string, broker: string) {
              return {
                eq(_c2: string, account: string) {
                  return {
                    neq: async (_c3: string, excludeId: string) => ({
                      data: [...table.values()]
                        .filter(
                          (r) =>
                            r.id !== excludeId &&
                            r.broker === broker &&
                            r.broker_account_id === account,
                        )
                        .map((r) => ({ id: r.id, name: r.name })),
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as DeleteQueryClient, claimClient, table };
}

const live = (id: string, name: string, account: string | null): DeletableRow => ({
  id,
  name,
  broker: "saxo",
  broker_account_id: account,
  mode: account ? "live" : "paper",
});

describe("deletePortfolioWithCleanup", () => {
  it("deletes the row and reports the broker account it freed", async () => {
    const { client, table } = makeDb([live("p1", "High risk sim", "SAXO-AAA")]);
    const out = await deletePortfolioWithCleanup(client, "p1");
    expect(out).toEqual({ ok: true, releasedBrokerAccountId: "SAXO-AAA" });
    expect(table.has("p1")).toBe(false);
  });

  it("lets another portfolio claim the account after the delete", async () => {
    const { client, claimClient } = makeDb([
      live("p1", "High risk sim", "SAXO-AAA"),
      live("p2", "Crypto Sim", null),
    ]);

    // Before: p2 cannot take the account.
    await expect(
      assertBrokerAccountUnclaimed(claimClient, {
        portfolioId: "p2",
        broker: "saxo",
        brokerAccountId: "SAXO-AAA",
      }),
    ).rejects.toThrow(/already linked to "High risk sim"/);

    await deletePortfolioWithCleanup(client, "p1");

    // After: the claim is gone.
    await expect(
      assertBrokerAccountUnclaimed(claimClient, {
        portfolioId: "p2",
        broker: "saxo",
        brokerAccountId: "SAXO-AAA",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows an immediate re-link of the freed account without a unique violation", async () => {
    const { client, table } = makeDb([
      live("p1", "High risk sim", "SAXO-AAA"),
      live("p2", "Crypto Sim", null),
    ]);
    await deletePortfolioWithCleanup(client, "p1");
    table.set("p2", { ...table.get("p2")!, broker_account_id: "SAXO-AAA", mode: "live" });
    expect(table.get("p2")!.broker_account_id).toBe("SAXO-AAA");
    expect([...table.values()].filter((r) => r.broker_account_id === "SAXO-AAA")).toHaveLength(1);
  });

  it("is a plain delete for paper portfolios holding no claim", async () => {
    const { client, table } = makeDb([live("p1", "Paper", null)]);
    const out = await deletePortfolioWithCleanup(client, "p1");
    expect(out.releasedBrokerAccountId).toBeNull();
    expect(table.size).toBe(0);
  });

  it("treats a blank account id as no claim", async () => {
    const { client } = makeDb([{ ...live("p1", "Odd", null), broker_account_id: "   " }]);
    const out = await deletePortfolioWithCleanup(client, "p1");
    expect(out.releasedBrokerAccountId).toBeNull();
  });

  it("throws a readable error when the portfolio doesn't exist", async () => {
    const { client } = makeDb([]);
    await expect(deletePortfolioWithCleanup(client, "missing")).rejects.toThrow(
      PORTFOLIO_NOT_FOUND_MESSAGE,
    );
  });

  it("restores the claim when the delete fails, leaving no half-cleaned row", async () => {
    const { client, table } = makeDb([live("p1", "High risk sim", "SAXO-AAA")], {
      deleteFails: "delete blocked by foreign key",
    });
    await expect(deletePortfolioWithCleanup(client, "p1")).rejects.toThrow(/foreign key/);
    expect(table.get("p1")!.broker_account_id).toBe("SAXO-AAA");
    expect(table.get("p1")!.mode).toBe("live");
  });

  it("restores the claim when the delete silently matches zero rows", async () => {
    const { client, table } = makeDb([live("p1", "High risk sim", "SAXO-AAA")], {
      hideOnDelete: true,
    });
    await expect(deletePortfolioWithCleanup(client, "p1")).rejects.toThrow(
      PORTFOLIO_NOT_FOUND_MESSAGE,
    );
    expect(table.get("p1")!.broker_account_id).toBe("SAXO-AAA");
  });

  it("never touches other portfolios' claims", async () => {
    const { client, table } = makeDb([
      live("p1", "One", "SAXO-AAA"),
      live("p2", "Two", "SAXO-BBB"),
    ]);
    await deletePortfolioWithCleanup(client, "p1");
    expect(table.get("p2")!.broker_account_id).toBe("SAXO-BBB");
    expect(table.get("p2")!.mode).toBe("live");
  });
});
