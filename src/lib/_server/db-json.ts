// Centralised helpers for narrowing arbitrary payloads into Supabase's
// generated column types.
//
// `asJson()` replaces the `as never` / `as unknown as never` escape hatch
// used all over the server code when writing to `jsonb` columns
// (audit-log request/response bodies, snapshots, regime signals, etc.).
// Structurally, arbitrary object literals aren't assignable to Supabase's
// recursive `Json` union because TS can't prove every leaf is JSON-safe,
// but we know these payloads are because we build them ourselves. A named
// helper makes the intent obvious and searchable, and lets us swap in a
// runtime `JSON.parse(JSON.stringify(v))` sanitiser later if we ever want
// to strip `undefined` / non-JSON leaves.
//
// `Insert<T>` and `Update<T>` give call sites a way to annotate row
// builders with the exact generated Supabase row type so column-name
// typos and enum drift fail at compile time instead of being masked by
// `as never`.

import type { Database, Json } from "@/integrations/supabase/types";

export function asJson<T>(value: T): Json {
  return value as unknown as Json;
}

export type Insert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];

export type Update<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];

export type Row<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
