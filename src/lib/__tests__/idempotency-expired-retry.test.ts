import { describe, it, expect } from "vitest";
import {
  IdempotencyKeyExpiredError,
  idempotencyFault,
  requestFingerprint,
  withIdempotency,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "../idempotency";
import { classifyRow, COMPLETED_TTL_MS, EXPIRED_GRACE_MS, IN_PROGRESS_TTL_MS } from "../idempotency-ttl";

function storeReturning(existing: IdempotencyRecord | null): { store: IdempotencyStore; runs: number[] } {
  const runs: number[] = [];
  const store: IdempotencyStore = {
    async reserve() {
      return existing ? { reserved: false as const, existing } : { reserved: true as const };
    },
    async complete() { runs.push(1); },
    async release() {},
  };
  return { store, runs };
}

const scope = { userId: "u1", endpoint: "deactivateLive", key: "k-1", request: { portfolioId: "p1" } };

describe("expired idempotency key retries", () => {
  it("answers with a clear expiry error instead of re-running the operation", async () => {
    const { store } = storeReturning({
      status: "expired",
      request_hash: requestFingerprint(scope.request),
      response: null,
      expired_at: "2026-07-31T09:00:00.000Z",
    });
    let ran = false;
    await expect(
      withIdempotency(store, scope, async () => { ran = true; return { ok: true }; }),
    ).rejects.toBeInstanceOf(IdempotencyKeyExpiredError);
    expect(ran).toBe(false);
  });

  it("message names the key, the closing time and says nothing was re-run", async () => {
    const err = new IdempotencyKeyExpiredError("k-1", "2026-07-31T09:00:00.000Z");
    expect(err.message).toContain('"k-1"');
    expect(err.message).toContain("2026-07-31T09:00:00.000Z");
    expect(err.message).toContain("NOT re-run");
    expect(err.expiredAt).toBe("2026-07-31T09:00:00.000Z");
  });

  it("still reports expiry when the stored request hash no longer matches", async () => {
    const { store } = storeReturning({ status: "expired", request_hash: "stale", response: null, expired_at: null });
    await expect(withIdempotency(store, scope, async () => 1)).rejects.toMatchObject({
      name: "IdempotencyKeyExpiredError",
    });
  });

  it("maps to a 409 fault with a stable code", () => {
    const fault = idempotencyFault(new IdempotencyKeyExpiredError("k-1", null));
    expect(fault).toMatchObject({ status: 409, code: "idempotency_key_expired" });
  });

  it("runs normally once the tombstone is gone (key treated as fresh)", async () => {
    const { store } = storeReturning(null);
    const out = await withIdempotency(store, scope, async () => ({ ok: true }));
    expect(out).toEqual({ replayed: false, response: { ok: true } });
  });
});

describe("row classification windows", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const completed = (expiresAt: number) => ({ status: "completed", expires_at: new Date(expiresAt).toISOString() });

  it("is live inside the completed TTL", () => {
    expect(classifyRow(completed(now + COMPLETED_TTL_MS), now)).toBe("live");
  });
  it("is expired inside the grace window", () => {
    expect(classifyRow(completed(now - 1), now)).toBe("expired");
    expect(classifyRow(completed(now - EXPIRED_GRACE_MS + 1000), now)).toBe("expired");
  });
  it("is purgeable past the grace window", () => {
    expect(classifyRow(completed(now - EXPIRED_GRACE_MS), now)).toBe("purgeable");
  });
  it("treats a stale reservation as reclaimable, never as expired", () => {
    expect(
      classifyRow({ status: "in_progress", created_at: new Date(now - IN_PROGRESS_TTL_MS - 1).toISOString() }, now),
    ).toBe("reclaimable");
  });
});
