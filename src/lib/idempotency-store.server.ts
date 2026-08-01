// Supabase-backed IdempotencyStore.
//
// Atomicity comes from the partial-free unique index
// `idempotency_keys_scope_unique (user_id, endpoint, idempotency_key)`:
// two concurrent inserts race, exactly one succeeds, the loser reads the row.
//
// Rows carry an `expires_at`; see idempotency-ttl.ts. An expired row is treated
// as absent here and deleted on sight, so a key becomes reusable the moment its
// TTL lapses even if the hourly database purge has not run.

import type { IdempotencyRecord, IdempotencyStore } from "./idempotency";
import { expiryFor, isExpiredRow } from "./idempotency-ttl";

type PgError = { message: string; code?: string };

export function isUniqueViolation(error: PgError | null | undefined): boolean {
  if (!error) return false;
  return error.code === "23505" || /duplicate key value|unique constraint/i.test(error.message);
}

/** Narrow shape so tests can pass a fake without the whole Supabase client. */
export type IdempotencySupabase = {
  from: (table: string) => any;
};

export function createIdempotencyStore(supabase: IdempotencySupabase): IdempotencyStore {
  const table = "idempotency_keys";

  async function hardDelete(args: { userId: string; endpoint: string; key: string }) {
    const del = await supabase
      .from(table)
      .delete()
      .eq("user_id", args.userId)
      .eq("endpoint", args.endpoint)
      .eq("idempotency_key", args.key);
    if (del.error) throw new Error(del.error.message);
  }

  /** Returns the live record, or null when missing or expired (expired rows are purged). */
  async function read(args: {
    userId: string;
    endpoint: string;
    key: string;
  }): Promise<IdempotencyRecord | null> {
    const res = await supabase
      .from(table)
      .select("status, request_hash, response, created_at, expires_at")
      .eq("user_id", args.userId)
      .eq("endpoint", args.endpoint)
      .eq("idempotency_key", args.key)
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) return null;
    if (isExpiredRow(res.data)) {
      await hardDelete(args).catch(() => undefined);
      return null;
    }
    return {
      status: res.data.status === "completed" ? "completed" : "in_progress",
      request_hash: String(res.data.request_hash ?? ""),
      response: res.data.response ?? null,
    };
  }

  async function insertReservation(args: {
    userId: string;
    endpoint: string;
    key: string;
    requestHash: string;
  }) {
    return supabase.from(table).insert({
      user_id: args.userId,
      endpoint: args.endpoint,
      idempotency_key: args.key,
      request_hash: args.requestHash,
      status: "in_progress",
      expires_at: expiryFor("in_progress"),
    });
  }

  return {
    async reserve(args) {
      const ins = await insertReservation(args);
      if (!ins.error) return { reserved: true };
      if (!isUniqueViolation(ins.error)) throw new Error(ins.error.message);

      // `read` deletes the row when it is past its TTL, so a null here can mean
      // "expired and reclaimed" as well as "winner rolled back": retry once.
      const existing = await read(args);
      if (!existing) {
        const retry = await insertReservation(args);
        if (!retry.error) return { reserved: true };
        if (!isUniqueViolation(retry.error)) throw new Error(retry.error.message);
        const raced = await read(args);
        if (!raced) return { reserved: true };
        return { reserved: false, existing: raced };
      }
      return { reserved: false, existing };
    },

    async complete(args) {
      const upd = await supabase
        .from(table)
        .update({
          status: "completed",
          response: args.response ?? null,
          completed_at: new Date().toISOString(),
          // Completing restarts the clock: the response stays replayable for
          // the full completed-TTL window.
          expires_at: expiryFor("completed"),
        })
        .eq("user_id", args.userId)
        .eq("endpoint", args.endpoint)
        .eq("idempotency_key", args.key);
      if (upd.error) throw new Error(upd.error.message);
    },

    async release(args) {
      const del = await supabase
        .from(table)
        .delete()
        .eq("user_id", args.userId)
        .eq("endpoint", args.endpoint)
        .eq("idempotency_key", args.key)
        .eq("status", "in_progress");
      if (del.error) throw new Error(del.error.message);
    },
  };
}
