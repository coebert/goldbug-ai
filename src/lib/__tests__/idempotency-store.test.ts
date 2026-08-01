// Supabase-backed idempotency store: unique-violation handling.

import { describe, it, expect } from "vitest";
import { createIdempotencyStore, isUniqueViolation } from "../idempotency-store.server";

type Row = Record<string, any>;

function fakeSupabase(rows: Row[]) {
  return {
    from() {
      const filters: Array<[string, any]> = [];
      const api: any = {
        select() {
          return api;
        },
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
          rows.push({ ...row });
          return Promise.resolve({ error: null });
        },
        update(patch: Row) {
          const chain: any = {
            eq(col: string, val: any) {
              filters.push([col, val]);
              return chain;
            },
            then(resolve: any) {
              for (const r of rows) {
                if (filters.every(([c, v]) => r[c] === v)) Object.assign(r, patch);
              }
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

describe("isUniqueViolation", () => {
  it("recognises 23505 and message text", () => {
    expect(isUniqueViolation({ code: "23505", message: "x" })).toBe(true);
    expect(isUniqueViolation({ message: "duplicate key value" })).toBe(true);
    expect(isUniqueViolation({ code: "42501", message: "denied" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("createIdempotencyStore", () => {
  it("reserves once, then reports the existing record", async () => {
    const rows: Row[] = [];
    const store = createIdempotencyStore(fakeSupabase(rows));

    const first = await store.reserve({ ...scope, requestHash: "h1" });
    expect(first).toEqual({ reserved: true });

    const second = await store.reserve({ ...scope, requestHash: "h1" });
    expect(second).toEqual({
      reserved: false,
      existing: { status: "in_progress", request_hash: "h1", response: null },
    });
  });

  it("stores and returns a completed response", async () => {
    const rows: Row[] = [];
    const store = createIdempotencyStore(fakeSupabase(rows));
    await store.reserve({ ...scope, requestHash: "h1" });
    await store.complete({ ...scope, response: { ok: true, changed: true } });

    const again = await store.reserve({ ...scope, requestHash: "h1" });
    expect(again).toEqual({
      reserved: false,
      existing: { status: "completed", request_hash: "h1", response: { ok: true, changed: true } },
    });
  });

  it("release frees an in-progress reservation", async () => {
    const rows: Row[] = [];
    const store = createIdempotencyStore(fakeSupabase(rows));
    await store.reserve({ ...scope, requestHash: "h1" });
    await store.release(scope);
    expect(rows).toHaveLength(0);
    expect(await store.reserve({ ...scope, requestHash: "h1" })).toEqual({ reserved: true });
  });
});
