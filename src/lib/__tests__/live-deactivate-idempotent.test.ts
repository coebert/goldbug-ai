// Contract tests for the idempotent deactivate endpoint.
//
// The guarantees under test:
//   1. First call flips live → paper, releases the broker account, reports
//      `changed: true`.
//   2. Every repeat call succeeds with `changed: false` and the SAME status
//      payload — no throwing, no clobbering.
//   3. The status always comes from a committed read, so a caller that lost
//      its first response can re-call to learn the truth.
//   4. Concurrent callers: exactly one reports `changed: true`.
//   5. A portfolio that isn't the caller's is indistinguishable from missing.

import { describe, it, expect, beforeEach } from "vitest";
import {
  deactivateLivePortfolio,
  readOwnedStatus,
  toLiveStatus,
  isLiveMode,
  PortfolioNotFoundError,
  type DeactivateClient,
} from "@/lib/live-deactivate";

type Row = {
  id: string;
  user_id: string;
  mode: string;
  broker: string | null;
  broker_account_id: string | null;
  live_paused: boolean;
};

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PID = "33333333-3333-4333-8333-333333333333";

/**
 * In-memory stand-in for the portfolios table honouring the two query shapes
 * the helper uses: a guarded UPDATE ... WHERE ... RETURNING, and a scoped
 * single-row SELECT. `updates` counts statements so we can assert that repeat
 * calls really do match zero rows rather than rewriting the row.
 */
function makeDb(initial: Row) {
  const state = { row: { ...initial } };
  let matchedUpdates = 0;
  let attemptedUpdates = 0;
  const hooks: { beforeUpdate?: () => void } = {};

  const client = {
    from(table: string) {
      expect(table).toBe("portfolios");
      return {
        update(patch: Record<string, unknown>) {
          return {
            eq(_c1: string, id: string) {
              return {
                eq(_c2: string, userId: string) {
                  return {
                    in(_c3: string, modes: readonly string[]) {
                      return {
                        select(_cols: string) {
                          attemptedUpdates++;
                          hooks.beforeUpdate?.();
                          const r = state.row;
                          const matches =
                            r.id === id && r.user_id === userId && modes.includes(r.mode);
                          if (!matches) return Promise.resolve({ data: [], error: null });
                          matchedUpdates++;
                          state.row = { ...r, ...(patch as Partial<Row>) };
                          return Promise.resolve({ data: [{ ...state.row }], error: null });
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        select(_cols: string) {
          return {
            eq(_c1: string, id: string) {
              return {
                eq(_c2: string, userId: string) {
                  return {
                    maybeSingle() {
                      const r = state.row;
                      const mine = r.id === id && r.user_id === userId;
                      return Promise.resolve({ data: mine ? { ...r } : null, error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as DeactivateClient;

  return {
    client,
    state,
    hooks,
    get matchedUpdates() {
      return matchedUpdates;
    },
    get attemptedUpdates() {
      return attemptedUpdates;
    },
  };
}

function liveRow(over: Partial<Row> = {}): Row {
  return {
    id: PID,
    user_id: OWNER,
    mode: "live_prod",
    broker: "saxo",
    broker_account_id: "SAXO-ACC-1",
    live_paused: true,
    ...over,
  };
}

describe("status helpers", () => {
  it("classifies live modes", () => {
    expect(isLiveMode("live_sim")).toBe(true);
    expect(isLiveMode("live_prod")).toBe(true);
    expect(isLiveMode("paper")).toBe(false);
    expect(isLiveMode(null)).toBe(false);
    expect(isLiveMode(undefined)).toBe(false);
  });

  it("normalises a row into the wire shape", () => {
    expect(toLiveStatus(liveRow())).toEqual({
      portfolio_id: PID,
      mode: "live_prod",
      is_live: true,
      broker: "saxo",
      broker_account_id: "SAXO-ACC-1",
      live_paused: true,
    });
  });

  it("defaults a missing mode to paper rather than guessing live", () => {
    expect(toLiveStatus({ id: PID }).mode).toBe("paper");
    expect(toLiveStatus({ id: PID }).is_live).toBe(false);
    expect(toLiveStatus({ id: PID }).live_paused).toBe(false);
  });
});

describe("deactivateLivePortfolio — first call", () => {
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb(liveRow());
  });

  it("flips to paper and releases the broker account", async () => {
    const res = await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.reason).toBe("released");
    expect(res.previous_mode).toBe("live_prod");
    expect(res.released_broker_account_id).toBe("SAXO-ACC-1");
    expect(res.status.mode).toBe("paper");
    expect(res.status.is_live).toBe(false);
    expect(res.status.broker_account_id).toBeNull();
    expect(res.status.live_paused).toBe(false);
  });

  it("keeps the broker key so the account can be re-linked later", async () => {
    const res = await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    expect(res.status.broker).toBe("saxo");
    expect(db.state.row.broker).toBe("saxo");
  });

  it("persists both halves of the transition together", async () => {
    await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    expect(db.state.row.mode).toBe("paper");
    expect(db.state.row.broker_account_id).toBeNull();
    expect(db.matchedUpdates).toBe(1);
  });

  it("works from live_sim too", async () => {
    const sim = makeDb(liveRow({ mode: "live_sim" }));
    const res = await deactivateLivePortfolio(sim.client, { portfolioId: PID, userId: OWNER });
    expect(res.changed).toBe(true);
    expect(res.previous_mode).toBe("live_sim");
  });
});

describe("idempotency", () => {
  it("returns changed:false with the same status on every repeat call", async () => {
    const db = makeDb(liveRow());
    const first = await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    const second = await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    const third = await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(third.changed).toBe(false);
    expect(second.reason).toBe("already_paper");
    // The observable status is byte-identical across all three responses.
    expect(second.status).toEqual(first.status);
    expect(third.status).toEqual(first.status);
  });

  it("never throws on a repeat call", async () => {
    const db = makeDb(liveRow({ mode: "paper", broker_account_id: null, live_paused: false }));
    await expect(
      deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER }),
    ).resolves.toMatchObject({ ok: true, changed: false, reason: "already_paper" });
  });

  it("reports previous_mode as paper when it was already paper", async () => {
    const db = makeDb(liveRow({ mode: "paper", broker_account_id: null, live_paused: false }));
    const res = await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    expect(res.previous_mode).toBe("paper");
    expect(res.released_broker_account_id).toBeNull();
  });

  it("does not rewrite the row on repeat calls", async () => {
    const db = makeDb(liveRow());
    await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    expect(db.attemptedUpdates).toBe(3);
    expect(db.matchedUpdates).toBe(1);
  });

  it("does not clobber a re-activation that happened in between", async () => {
    const db = makeDb(liveRow());
    await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });

    // User re-links and goes live again on a different account.
    db.state.row = { ...db.state.row, mode: "live_sim", broker_account_id: "SAXO-ACC-2" };

    // A late duplicate of the ORIGINAL deactivate would flip it back if the
    // endpoint were not guarded — it must instead be treated as a fresh call.
    const late = await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    expect(late.changed).toBe(true);
    expect(late.released_broker_account_id).toBe("SAXO-ACC-2");
  });

  it("reports the committed status when another caller won the race", async () => {
    const db = makeDb(liveRow());
    // Between the pre-read and the UPDATE, a concurrent request commits first.
    db.hooks.beforeUpdate = () => {
      db.state.row = { ...db.state.row, mode: "paper", broker_account_id: null, live_paused: false };
      db.hooks.beforeUpdate = undefined;
    };

    const res = await deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER });
    expect(res.changed).toBe(false);
    expect(res.status.mode).toBe("paper");
    expect(res.status.broker_account_id).toBeNull();
    // The pre-read still saw live, and we report it honestly as the prior mode.
    expect(res.previous_mode).toBe("live_prod");
  });

  it("lets exactly one of many concurrent callers report changed:true", async () => {
    const db = makeDb(liveRow());
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OWNER }),
      ),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(results.every((r) => r.ok && r.status.mode === "paper")).toBe(true);
    expect(db.matchedUpdates).toBe(1);
  });
});

describe("ownership", () => {
  it("hides another user's portfolio behind the same not-found error", async () => {
    const db = makeDb(liveRow());
    await expect(
      deactivateLivePortfolio(db.client, { portfolioId: PID, userId: OTHER }),
    ).rejects.toBeInstanceOf(PortfolioNotFoundError);
    // And it must not have touched the row.
    expect(db.state.row.mode).toBe("live_prod");
    expect(db.matchedUpdates).toBe(0);
  });

  it("throws not-found for an unknown portfolio id", async () => {
    const db = makeDb(liveRow());
    await expect(
      readOwnedStatus(db.client, { portfolioId: "44444444-4444-4444-8444-444444444444", userId: OWNER }),
    ).rejects.toBeInstanceOf(PortfolioNotFoundError);
  });
});
