// Idempotency-Key contract: same key ⇒ same payload, always.

import { describe, it, expect, vi } from "vitest";
import {
  withIdempotency,
  requestFingerprint,
  canonicalJson,
  normalizeIdempotencyKey,
  IdempotencyKeyReuseError,
  IdempotencyInProgressError,
  InvalidIdempotencyKeyError,
  type IdempotencyStore,
  type IdempotencyRecord,
} from "../idempotency";

function memoryStore(): IdempotencyStore & { rows: Map<string, IdempotencyRecord> } {
  const rows = new Map<string, IdempotencyRecord>();
  const id = (a: { userId: string; endpoint: string; key: string }) =>
    `${a.userId}|${a.endpoint}|${a.key}`;
  return {
    rows,
    async reserve(args) {
      const k = id(args);
      const existing = rows.get(k);
      if (existing) return { reserved: false, existing };
      rows.set(k, { status: "in_progress", request_hash: args.requestHash, response: null });
      return { reserved: true };
    },
    async complete(args) {
      const k = id(args);
      const row = rows.get(k);
      if (row) rows.set(k, { ...row, status: "completed", response: args.response });
    },
    async release(args) {
      const k = id(args);
      if (rows.get(k)?.status === "in_progress") rows.delete(k);
    },
  };
}

const scope = { userId: "u1", endpoint: "deactivateLive", key: "key-1" };
const request = { portfolioId: "p1", reason: null };

describe("canonical fingerprint", () => {
  it("ignores key order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(requestFingerprint({ a: 1, b: [1, { z: 1, y: 2 }] })).toBe(
      requestFingerprint({ b: [1, { y: 2, z: 1 }], a: 1 }),
    );
  });

  it("distinguishes different payloads", () => {
    expect(requestFingerprint({ portfolioId: "p1" })).not.toBe(
      requestFingerprint({ portfolioId: "p2" }),
    );
  });

  it("treats undefined fields as absent", () => {
    expect(requestFingerprint({ a: 1, b: undefined })).toBe(requestFingerprint({ a: 1 }));
  });
});

describe("normalizeIdempotencyKey", () => {
  it("trims and passes through", () => {
    expect(normalizeIdempotencyKey("  abc ")).toBe("abc");
  });
  it("treats empty/missing as no key", () => {
    expect(normalizeIdempotencyKey("")).toBeNull();
    expect(normalizeIdempotencyKey(null)).toBeNull();
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
  });
  it("rejects non-strings and over-long keys", () => {
    expect(() => normalizeIdempotencyKey(42)).toThrow(InvalidIdempotencyKeyError);
    expect(() => normalizeIdempotencyKey("x".repeat(256))).toThrow(InvalidIdempotencyKeyError);
  });
});

describe("withIdempotency", () => {
  it("runs the operation and stores the response on first call", async () => {
    const store = memoryStore();
    const op = vi.fn(async () => ({ ok: true, changed: true }));
    const out = await withIdempotency(store, { ...scope, request }, op);
    expect(out).toEqual({ replayed: false, response: { ok: true, changed: true } });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("replays the ORIGINAL payload on repeat, without re-running", async () => {
    const store = memoryStore();
    let calls = 0;
    const op = async () => ({ ok: true, changed: calls++ === 0, seq: calls });

    const first = await withIdempotency(store, { ...scope, request }, op);
    const second = await withIdempotency(store, { ...scope, request }, op);
    const third = await withIdempotency(store, { ...scope, request }, op);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(third.replayed).toBe(true);
    // Crucially `changed: true` survives the replay — not a fresh already_paper.
    expect(second.response).toEqual(first.response);
    expect(third.response).toEqual(first.response);
    expect(calls).toBe(1);
  });

  it("rejects the same key with a different request", async () => {
    const store = memoryStore();
    await withIdempotency(store, { ...scope, request }, async () => ({ ok: true }));
    await expect(
      withIdempotency(
        store,
        { ...scope, request: { portfolioId: "OTHER", reason: null } },
        async () => ({ ok: true }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  it("lets exactly one of two concurrent callers run the operation", async () => {
    const store = memoryStore();
    let running = 0;
    let ran = 0;
    const op = async () => {
      running += 1;
      expect(running).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      ran += 1;
      return { ok: true };
    };

    const results = await Promise.allSettled([
      withIdempotency(store, { ...scope, request }, op),
      withIdempotency(store, { ...scope, request }, op),
    ]);

    expect(ran).toBe(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      IdempotencyInProgressError,
    );

    // Retrying after the winner finished yields the stored payload.
    const retry = await withIdempotency(store, { ...scope, request }, op);
    expect(retry).toEqual({ replayed: true, response: { ok: true } });
    expect(ran).toBe(1);
  });

  it("frees the key when the operation throws, so a retry can succeed", async () => {
    const store = memoryStore();
    await expect(
      withIdempotency(store, { ...scope, request }, async () => {
        throw new Error("broker down");
      }),
    ).rejects.toThrow("broker down");

    const retry = await withIdempotency(store, { ...scope, request }, async () => ({ ok: true }));
    expect(retry).toEqual({ replayed: false, response: { ok: true } });
  });

  it("runs normally with no key and no store", async () => {
    const store = memoryStore();
    const a = await withIdempotency(store, { ...scope, key: null, request }, async () => ({ n: 1 }));
    const b = await withIdempotency(null, { ...scope, request }, async () => ({ n: 2 }));
    expect(a).toEqual({ replayed: false, response: { n: 1 } });
    expect(b).toEqual({ replayed: false, response: { n: 2 } });
    expect(store.rows.size).toBe(0);
  });

  it("scopes keys per user and per endpoint", async () => {
    const store = memoryStore();
    await withIdempotency(store, { ...scope, request }, async () => ({ who: "u1" }));
    const other = await withIdempotency(
      store,
      { ...scope, userId: "u2", request },
      async () => ({ who: "u2" }),
    );
    const otherEndpoint = await withIdempotency(
      store,
      { ...scope, endpoint: "activateLive", request },
      async () => ({ who: "endpoint2" }),
    );
    expect(other.replayed).toBe(false);
    expect(otherEndpoint.replayed).toBe(false);
  });
});
