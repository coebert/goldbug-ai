// Standardises "which Supabase client should this server code use?".
//
// Every server-side helper that touches a user-owned row must answer two
// questions before it runs:
//
//   1. Which client executes the query?
//        - The caller's user-scoped client (from `context.supabase` inside
//          `requireSupabaseAuth`) — RLS enforces ownership as that user.
//        - `supabaseAdmin` (service_role) — RLS is bypassed. Only cron
//          paths and cross-user maintenance loops should hit this branch.
//   2. Whose rows are we touching?
//        - Every admin-mode query MUST re-scope with `.eq("user_id", userId)`
//          or an equivalent join predicate. RLS is not doing that for us.
//
// This module bundles both into a single object so sidecar signatures stop
// leaking the choice into every caller: instead of
//
//     doWork(portfolioId, client?: SupabaseClient, userId?: string)
//
// we pass an `OwnedDbClient` and the helper below picks the right client.
// The `isAdmin` flag is a lint-friendly reminder that defence-in-depth
// filters are required on that branch (RLS is not enforcing ownership).
//
// This file lives in `_server/` and imports `supabaseAdmin` at module
// scope, so the eslint boundary rule blocks any route/component from
// transitively reaching it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

export type ScopedDbClient = SupabaseClient<Database>;

export interface OwnedDbClient {
  /** The client to run queries against. */
  db: ScopedDbClient;
  /** The user whose rows the caller is authorised to touch. */
  userId: string;
  /**
   * `true` when `db` is `supabaseAdmin` (RLS bypassed). Callers on this
   * branch MUST add `.eq("user_id", userId)` (or an equivalent join
   * predicate) to every read/write — RLS is not doing it for them.
   */
  isAdmin: boolean;
}

/**
 * Build an `OwnedDbClient` for the given user.
 *
 * - Pass `context.supabase` from a `requireSupabaseAuth`-guarded server fn
 *   to run under the caller's identity (RLS enforces ownership).
 * - Omit `client` for cron / background paths that have no session; the
 *   helper falls back to `supabaseAdmin` and flips `isAdmin` on so the
 *   consumer knows to add explicit `user_id` filters.
 *
 * Never invent a `userId`: it must come from `context.userId`, a verified
 * portfolio row, or a cron payload that has already been authenticated.
 */
export function withOwnedClient(
  userId: string,
  client?: ScopedDbClient,
): OwnedDbClient {
  return {
    db: client ?? supabaseAdmin,
    userId,
    isAdmin: !client,
  };
}
