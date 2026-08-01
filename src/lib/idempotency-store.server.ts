// Supabase-backed IdempotencyStore.
//
// Atomicity comes from the partial-free unique index
// `idempotency_keys_scope_unique (user_id, endpoint, idempotency_key)`:
// two concurrent inserts race, exactly one succeeds, the loser reads the row.

import type { IdempotencyRecord, IdempotencyStore } from "./idempotency";

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

  async function read(args: {
    userId: string;
    endpoint: string;
    key: string;
  }): Promise<IdempotencyRecord | null> {
    const res = await supabase
      .from(table)
      .select("status, request_hash, response")
      .eq("user_id", args.userId)
      .eq("endpoint", args.endpoint)
      .eq("idempotency_key", args.key)
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) return null;
    return {
      status: res.data.status === "completed" ? "completed" : "in_progress",
      request_hash: String(res.data.request_hash ?? ""),
      response: res.data.response ?? null,
    };
  }

  return {
    async reserve(args) {
      const ins = await supabase.from(table).insert({
        user_id: args.userId,
        endpoint: args.endpoint,
        idempotency_key: args.key,
        request_hash: args.requestHash,
        status: "in_progress",
      });
      if (!ins.error) return { reserved: true };
      if (!isUniqueViolation(ins.error)) throw new Error(ins.error.message);

      const existing = await read(args);
      // Vanishingly rare: the winner rolled back between our insert and read.
      if (!existing) return { reserved: true };
      return { reserved: false, existing };
    },

    async complete(args) {
      const upd = await supabase
        .from(table)
        .update({
          status: "completed",
          response: args.response ?? null,
          completed_at: new Date().toISOString(),
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
