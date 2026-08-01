// TTL behaviour for stored Idempotency-Key entries.

import { describe, it, expect } from "vitest";
import { createIdempotencyStore } from "../idempotency-store.server";
import {
  COMPLETED_TTL_MS,
  IN_PROGRESS_TTL_MS,
  expiryFor,
  isExpiredRow,
} from "../idempotency-ttl";

type Row = Record<string, any>;

function fakeSupabase(rows: Row[]) {
  return {
    from() {
      const filters: Array<[string, any]> = [];
      const api: any = {
        select: () => api,
        eq(col: string, val: any) {
          filters.push([col, val]);
          return api;
        },
        maybeSingle() {
          const found = rows.find((r) => filters.every(([c, v]) => r[c] === v));
          return Promise.resolve({ data: found ?? null, error: null });
        },
        insert(row: Row) {
          const clash = rows.find(
            (r) =>
              r["user_id"] === row["user_id"] &&
              r["endpoint"] === row["endpoint"] &&
              r["idempotency_key"] === row["idempotency_key"],
          );
          if (clash) {
            return Promise.resolve({
              error: { code: "23505", message: "duplicate key value violates unique constraint" },
            });
          }
          rows.push({ created_at: new Date().toISOString(), ...row });
          return Promise.resolve({ error: null });
        },
        update(patch: Row) {
          const chain: any = {
            eq(col: string, val: any) {
              filters.push([col, val]);
              return chain;
            },
            then(resolve: any) {
              for (const r of rows) if (filters.every(([c, v]) => r[c] === v)) Object.assign(r, patch);
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return chain;
        },
        delete() {
          const chain: any = {
            eq(col: string, val: any) {
              filters.push([col, val]);
              return chain;
            },
            then(resolve: any) {
              for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (filters.every(([c, v]) => rows[i]![c] === v)) rows.splice(i, 1);
              }
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
      return api;
    },
  };
}

const scope = { userId: "u1", endpoint: "deactivateLive", key: "k1" };
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("isExpiredRow", () => {
  it("keeps a fresh completed row", () => {
    expect(isExpiredRow({ status: "completed", expires_at: iso(60_000) })).toBe(false);
  });

  it("expires a completed row past expires_at", () => {
    expect(isExpiredRow({ status: "completed", expires_at: iso(-1) })).toBe(true);
  });

  it("expires a stale in_progress reservation even with a future expires_at", () => {
    expect(
      isExpiredRow({
        status: "in_progress",
        created_at: iso(-IN_PROGRESS_TTL_MS - 1000),
        expires_at: iso(COMPLETED_TTL_MS),
      }),
    ).toBe(true);
  });

  it("keeps a recent in_progress reservation", () => {
    expect(
      isExpiredRow({ status: "in_progress", created_at: iso(-1000), expires_at: iso(60_000) }),
    ).toBe(false);
  });

  it("tolerates missing/garbage timestamps and null rows", () => {
    expect(isExpiredRow(null)).toBe(false);
    expect(isExpiredRow({ status: "completed" })).toBe(false);
    expect(isExpiredRow({ status: "completed", expires_at: "not-a-date" })).toBe(false);
  });
});

describe("expiryFor", () => {
  it("uses the short window for reservations and the long one for responses", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(Date.parse(expiryFor("in_progress", now)) - now).toBe(IN_PROGRESS_TTL_MS);
    expect(Date.parse(expiryFor("completed", now)) - now).toBe(COMPLETED_TTL_MS);
  });
});

describe("store TTL enforcement", () => {
  it("stamps expires_at on reservation and extends it on completion", async () => {
    const rows: Row[] = [];
    const store = createIdempotencyStore(fakeSupabase(rows));
    await store.reserve({ ...scope, requestHash: "h1" });
    const reserved = Date.parse(rows[0]!["expires_at"]);
    expect(reserved - Date.now()).toBeLessThanOrEqual(IN_PROGRESS_TTL_MS + 1000);

    await store.complete({ ...scope, response: { ok: true } });
    expect(Date.parse(rows[0]!["expires_at"])).toBeGreaterThan(reserved);
  });

  it("treats an expired completed row as absent and lets the key be reused", async () => {
    const rows: Row[] = [
      {
        user_id: scope.userId,
        endpoint: scope.endpoint,
        idempotency_key: scope.key,
        request_hash: "old",
        status: "completed",
        response: { stale: true },
        created_at: iso(-COMPLETED_TTL_MS - 1000),
        expires_at: iso(-1000),
      },
    ];
    const store = createIdempotencyStore(fakeSupabase(rows));

    const res = await store.reserve({ ...scope, requestHash: "new" });
    expect(res).toEqual({ reserved: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!["request_hash"]).toBe("new");
    expect(rows[0]!["status"]).toBe("in_progress");
  });

  it("reclaims a stuck in_progress reservation after its TTL", async () => {
    const rows: Row[] = [
      {
        user_id: scope.userId,
        endpoint: scope.endpoint,
        idempotency_key: scope.key,
        request_hash: "h1",
        status: "in_progress",
        created_at: iso(-IN_PROGRESS_TTL_MS - 5000),
        expires_at: iso(-5000),
      },
    ];
    const store = createIdempotencyStore(fakeSupabase(rows));
    expect(await store.reserve({ ...scope, requestHash: "h1" })).toEqual({ reserved: true });
  });

  it("still replays a live completed response", async () => {
    const rows: Row[] = [];
    const store = createIdempotencyStore(fakeSupabase(rows));
    await store.reserve({ ...scope, requestHash: "h1" });
    await store.complete({ ...scope, response: { ok: true } });

    expect(await store.reserve({ ...scope, requestHash: "h1" })).toEqual({
      reserved: false,
      existing: { status: "completed", request_hash: "h1", response: { ok: true } },
    });
  });
});
