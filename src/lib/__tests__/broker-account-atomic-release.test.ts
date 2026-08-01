import { describe, it, expect } from "vitest";
import {
  releaseBrokerAccountAtomically,
  releaseBrokerAccountPatch,
  assertBrokerAccountUnclaimed,
  LIVE_MODES,
  type AtomicReleaseClient,
  type AtomicReleaseRow,
  type ClaimQueryClient,
} from "@/lib/broker-account-claim";

type Row = AtomicReleaseRow & { user_id: string; broker: string | null; name: string | null };

/**
 * In-memory `portfolios` table whose UPDATE behaves like a single Postgres
 * statement: the WHERE guards and the patch are applied together, and readers
 * only ever see the before or after state — never a half-written row.
 */
function makeDb(rows: Row[], opts: { failWith?: string; partialWrite?: boolean } = {}) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  /** Snapshots taken by a concurrent reader between the guard and the write. */
  const observed: Array<{ mode: string | null; broker_account_id: string | null }> = [];

  const client: AtomicReleaseClient = {
    from() {
      return {
        update(patch: Record<string, unknown>) {
          return {
            eq(_c: string, id: string) {
              return {
                eq(_c2: string, userId: string) {
                  return {
                    in(_c3: string, modes: readonly string[]) {
                      return {
                        select: async (_cols: string) => {
                          if (opts.failWith) {
                            return { data: null, error: { message: opts.failWith } };
                          }
                          const row = table.get(id);
                          if (!row || row.user_id !== userId || !modes.includes(row.mode ?? "")) {
                            return { data: [], error: null };
                          }
                          const applied = opts.partialWrite
                            ? { ...row, mode: "paper" } // account id left behind
                            : { ...row, ...(patch as Partial<Row>) };
                          table.set(id, applied as Row);
                          observed.push({
                            mode: applied.mode ?? null,
                            broker_account_id: applied.broker_account_id ?? null,
                          });
                          return {
                            data: [
                              {
                                id: applied.id,
                                mode: applied.mode,
                                broker_account_id: applied.broker_account_id,
                                live_paused: applied.live_paused,
                              },
                            ],
                            error: null,
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

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

  return { client, claimClient, table, observed };
}

const liveRow = (over: Partial<Row> = {}): Row => ({
  id: "p1",
  user_id: "u1",
  name: "High risk sim",
  broker: "saxo",
  broker_account_id: "SAXO-AAA",
  mode: "live_sim",
  live_paused: true,
  ...over,
});

describe("releaseBrokerAccountAtomically", () => {
  it("flips mode and nulls the account in the same write", async () => {
    const { client, table } = makeDb([liveRow()]);
    const out = await releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" });
    expect(out.changed).toBe(true);
    expect(table.get("p1")).toMatchObject({
      mode: "paper",
      broker_account_id: null,
      live_paused: false,
    });
  });

  it("never exposes a paper row that still holds its broker account", async () => {
    const { client, observed } = makeDb([liveRow()]);
    await releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" });
    for (const snap of observed) {
      expect(snap.mode === "paper" && snap.broker_account_id !== null).toBe(false);
    }
  });

  it("rejects a half-applied write instead of reporting success", async () => {
    const { client } = makeDb([liveRow()], { partialWrite: true });
    await expect(
      releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" }),
    ).rejects.toThrow(/did not fully release/i);
  });

  it("is a no-op for a portfolio already in paper", async () => {
    const { client, table } = makeDb([liveRow({ mode: "paper", broker_account_id: null })]);
    const out = await releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" });
    expect(out).toEqual({ changed: false, row: null });
    expect(table.get("p1")!.mode).toBe("paper");
  });

  it("only the first of two concurrent deactivations reports a change", async () => {
    const { client } = makeDb([liveRow()]);
    const [a, b] = await Promise.all([
      releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" }),
      releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" }),
    ]);
    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1);
  });

  it("refuses to release a portfolio owned by someone else", async () => {
    const { client, table } = makeDb([liveRow()]);
    const out = await releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u2" });
    expect(out.changed).toBe(false);
    expect(table.get("p1")!.broker_account_id).toBe("SAXO-AAA");
  });

  it("surfaces the database error and leaves the row untouched", async () => {
    const { client, table } = makeDb([liveRow()], { failWith: "connection reset" });
    await expect(
      releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" }),
    ).rejects.toThrow("connection reset");
    expect(table.get("p1")!.broker_account_id).toBe("SAXO-AAA");
    expect(table.get("p1")!.mode).toBe("live_sim");
  });

  it("frees the account for another portfolio immediately afterwards", async () => {
    const { client, claimClient } = makeDb([
      liveRow(),
      liveRow({ id: "p2", name: "Crypto Sim", broker_account_id: null, mode: "paper" }),
    ]);
    await releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" });
    await expect(
      assertBrokerAccountUnclaimed(claimClient, {
        portfolioId: "p2",
        broker: "saxo",
        brokerAccountId: "SAXO-AAA",
      }),
    ).resolves.toBeUndefined();
  });

  it("guards on both live modes and the patch it applies", () => {
    expect([...LIVE_MODES]).toEqual(["live_sim", "live_prod"]);
    expect(releaseBrokerAccountPatch()).toEqual({
      mode: "paper",
      live_paused: false,
      broker_account_id: null,
    });
  });

  it("releases live_prod portfolios too", async () => {
    const { client, table } = makeDb([liveRow({ mode: "live_prod" })]);
    const out = await releaseBrokerAccountAtomically(client, { portfolioId: "p1", userId: "u1" });
    expect(out.changed).toBe(true);
    expect(table.get("p1")!.broker_account_id).toBeNull();
  });
});
