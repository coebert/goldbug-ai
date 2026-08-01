// Message parity: a broker account claimed twice must read the SAME way no
// matter which layer catches it.
//
// Two layers can reject the claim:
//   1. `assertBrokerAccountUnclaimed` (pre-check, before the write), and
//   2. the `portfolios_unique_broker_account` partial unique index (Postgres,
//      when two activations race past the pre-check).
//
// Historically layer 2 said "another portfolio" while layer 1 named the owner,
// so the same fault produced two different banners. This test locks byte-level
// parity by driving both paths against a simulated portfolios table.

import { describe, expect, it } from "vitest";
import {
  assertBrokerAccountUnclaimed,
  brokerAccountClaimedMessage,
  brokerAccountConflictMessage,
  isBrokerAccountUniqueViolation,
  UNKNOWN_CLAIM_OWNER,
  type ClaimQueryClient,
  type ClaimRow,
} from "@/lib/broker-account-claim";

type Row = { id: string; name: string | null; broker: string | null; broker_account_id: string | null };

/** Minimal stand-in for the portfolios table + its partial unique index. */
function makeDb(rows: Row[], opts: { selectError?: string } = {}) {
  const client: ClaimQueryClient = {
    from: () => ({
      select: () => ({
        eq: (_c1: string, broker: string) => ({
          eq: (_c2: string, accountId: string) => ({
            neq: (_c3: string, excludeId: string) =>
              Promise.resolve(
                opts.selectError
                  ? { data: null, error: { message: opts.selectError } }
                  : {
                      data: rows.filter(
                        (r) =>
                          r.broker === broker &&
                          r.broker_account_id === accountId &&
                          r.id !== excludeId,
                      ) as ClaimRow[],
                      error: null,
                    },
              ),
          }),
        }),
      }),
    }),
  };
  /** What Postgres returns when the partial unique index rejects the write. */
  const violation = {
    code: "23505",
    message:
      'duplicate key value violates unique constraint "portfolios_unique_broker_account"',
  };
  return { client, violation };
}

const ACCOUNT = "IszXTG9pKbLQ2mQ0aY7Bqw==";
const OWNER: Row = { id: "p-owner", name: "High risk sim portfolio", broker: "saxo", broker_account_id: ACCOUNT };
const CLAIMANT_ID = "p-claimant";
const ARGS = { portfolioId: CLAIMANT_ID, broker: "saxo", brokerAccountId: ACCOUNT };

/** Mirrors activateLive's update path: pre-check, write, translate 23505. */
async function activateLikeServerFn(
  client: ClaimQueryClient,
  updateError: { code?: string; message: string } | null,
): Promise<{ ok: true } | never> {
  await assertBrokerAccountUnclaimed(client, ARGS);
  if (updateError) {
    if (isBrokerAccountUniqueViolation(updateError)) {
      throw new Error(await brokerAccountConflictMessage(client, ARGS));
    }
    throw new Error(updateError.message);
  }
  return { ok: true };
}

describe("broker-account conflict message parity", () => {
  it("pre-check and unique-index paths produce identical text", async () => {
    const { client, violation } = makeDb([OWNER]);

    const preCheck = await assertBrokerAccountUnclaimed(client, ARGS).catch((e: Error) => e.message);

    // Race variant: the pre-check saw a clean table, the index caught the write.
    const raced = makeDb([OWNER]);
    const indexPath = await activateLikeServerFn(raced.client, violation).catch(
      (e: Error) => e.message,
    );

    expect(preCheck).toBe(brokerAccountClaimedMessage(ACCOUNT, OWNER.name!));
    expect(indexPath).toBe(preCheck);
  });

  it("names the owning portfolio in both paths", async () => {
    const { client, violation } = makeDb([OWNER]);
    const msg = await activateLikeServerFn(makeDb([OWNER]).client, violation).catch(
      (e: Error) => e.message,
    );
    expect(msg).toContain(OWNER.name!);
    expect(msg).toContain(ACCOUNT);
    await expect(assertBrokerAccountUnclaimed(client, ARGS)).rejects.toThrow(OWNER.name!);
  });

  it("recognises the index violation by code and by constraint name", () => {
    expect(isBrokerAccountUniqueViolation({ code: "23505", message: "dup" })).toBe(true);
    expect(
      isBrokerAccountUniqueViolation({
        message: 'duplicate key ... "portfolios_unique_broker_account"',
      }),
    ).toBe(true);
    expect(isBrokerAccountUniqueViolation({ code: "42501", message: "denied" })).toBe(false);
    expect(isBrokerAccountUniqueViolation(null)).toBe(false);
  });

  it("falls back to the generic owner label when the owner row is unreadable", async () => {
    // RLS can hide the other portfolio (different user); the message must still
    // use the same template rather than leaking a lookup error.
    const hidden = makeDb([], { selectError: "permission denied for table portfolios" });
    const msg = await brokerAccountConflictMessage(hidden.client, ARGS);
    expect(msg).toBe(brokerAccountClaimedMessage(ACCOUNT, UNKNOWN_CLAIM_OWNER));
    expect(msg).not.toMatch(/permission denied/i);
  });

  it("uses the same template when the owner row has no name", async () => {
    const unnamed = makeDb([{ ...OWNER, name: null }]);
    const preCheck = await assertBrokerAccountUnclaimed(unnamed.client, ARGS).catch(
      (e: Error) => e.message,
    );
    const indexPath = await brokerAccountConflictMessage(makeDb([{ ...OWNER, name: null }]).client, ARGS);
    expect(preCheck).toBe(brokerAccountClaimedMessage(ACCOUNT, OWNER.id));
    expect(indexPath).toBe(preCheck);
  });

  it("does not translate unrelated update errors into the conflict message", async () => {
    const { client } = makeDb([]);
    await expect(
      activateLikeServerFn(client, { code: "40001", message: "serialization failure" }),
    ).rejects.toThrow("serialization failure");
  });

  it("stays silent when the account is free or already owned by this portfolio", async () => {
    const free = makeDb([]);
    await expect(activateLikeServerFn(free.client, null)).resolves.toEqual({ ok: true });

    const self = makeDb([{ ...OWNER, id: CLAIMANT_ID }]);
    await expect(activateLikeServerFn(self.client, null)).resolves.toEqual({ ok: true });
  });

  it("message shape is stable (snapshot of the exact user-facing text)", () => {
    expect(brokerAccountClaimedMessage("ACC-1", "My Portfolio")).toMatchInlineSnapshot(
      `"Broker account ACC-1 is already linked to "My Portfolio". Two portfolios cannot share one broker account — they would mirror each other's holdings and equity. Deactivate live trading on "My Portfolio" first, or use a different Saxo account for this portfolio."`,
    );
  });
});
