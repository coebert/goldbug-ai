#!/usr/bin/env bun
/**
 * CI guard: SECURITY DEFINER permission constraints.
 *
 * A SECURITY DEFINER function runs with the privileges of its owner, so it is
 * the single easiest way to hand a signed-in user (or `anon`) more power than
 * their RLS policies allow. This script statically audits every such function
 * declared in `supabase/migrations` and fails the build unless:
 *
 *   1. `search_path` is pinned (`SET search_path = public`) — otherwise a
 *      caller-controlled schema can shadow the tables the body references.
 *   2. EXECUTE is never granted to `PUBLIC` or `anon`.
 *   3. The function is either on the reviewed allowlist below, or its
 *      privileges are locked to `service_role` with an explicit REVOKE.
 *
 * Adding a definer function therefore requires a deliberate entry here, which
 * is the review checkpoint we want for a real-money app.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");

/**
 * Functions that are intentionally callable by signed-in users, with the
 * reason each one is safe. Everything else must be service_role only.
 */
const CALLABLE_BY_AUTHENTICATED: Record<string, string> = {
  has_role:
    "Read-only role lookup. Exists precisely to break RLS recursion on user_roles; returns a boolean and leaks nothing about other users.",
};

/** Trigger functions have no direct call surface — EXECUTE grants are moot. */
const TRIGGER_FUNCTIONS = new Set([
  "tg_touch_updated_at",
  "tg_sync_ai_audit_from_order",
]);

type Failure = { fn: string; problem: string };

function readMigrations(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
    .join("\n\n");
}

/** Split the combined SQL into CREATE FUNCTION bodies keyed by function name. */
function extractDefinerFunctions(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const name = match[1].toLowerCase();
    // Body runs until the terminating $$; of the function definition.
    const rest = sql.slice(match.index);
    const endMarker = /\$\$\s*;/.exec(rest);
    const body = rest.slice(0, endMarker ? endMarker.index + endMarker[0].length : 4000);
    if (!/security\s+definer/i.test(body)) continue;
    // Later migrations replace earlier ones — keep the newest definition.
    out.set(name, body);
  }
  return out;
}

function main(): void {
  const sql = readMigrations();
  const definers = extractDefinerFunctions(sql);
  const failures: Failure[] = [];

  if (definers.size === 0) {
    console.error("check:security-definer: parsed 0 functions — parser is broken.");
    process.exit(1);
  }

  for (const [fn, body] of definers) {
    if (!/set\s+search_path\s*(=|to)\s*/i.test(body)) {
      failures.push({
        fn,
        problem: "SECURITY DEFINER without a pinned search_path (add `SET search_path = public`).",
      });
    }

    const grants = [
      ...sql.matchAll(
        new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(([^)]*)\\)\\s*TO\\s+([^;]+);`, "gi"),
      ),
    ].map((m) => m[2].toLowerCase());

    for (const grantees of grants) {
      if (/\bpublic\b/.test(grantees) || /\banon\b/.test(grantees)) {
        failures.push({
          fn,
          problem: `EXECUTE granted to a public role (${grantees.trim()}). SECURITY DEFINER must never be anon/PUBLIC callable.`,
        });
      }
      if (/\bauthenticated\b/.test(grantees) && !(fn in CALLABLE_BY_AUTHENTICATED)) {
        failures.push({
          fn,
          problem:
            "EXECUTE granted to `authenticated` but the function is not on the reviewed allowlist in scripts/check-security-definer.ts.",
        });
      }
    }

    if (TRIGGER_FUNCTIONS.has(fn) || fn in CALLABLE_BY_AUTHENTICATED) continue;

    const revoked = new RegExp(
      `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${fn}\\s*\\(`,
      "i",
    ).test(sql);
    if (!revoked) {
      failures.push({
        fn,
        problem:
          "No `REVOKE ALL ... FROM PUBLIC, anon, authenticated`. Postgres grants EXECUTE to PUBLIC by default, so this function is callable by every signed-in user.",
      });
    }
  }

  console.log(`check:security-definer: audited ${definers.size} SECURITY DEFINER function(s).`);
  for (const fn of definers.keys()) {
    const note = TRIGGER_FUNCTIONS.has(fn)
      ? "trigger"
      : fn in CALLABLE_BY_AUTHENTICATED
        ? "authenticated (allowlisted)"
        : "service_role only";
    console.log(`  - public.${fn} — ${note}`);
  }

  if (failures.length > 0) {
    console.error("\ncheck:security-definer FAILED:");
    for (const f of failures) console.error(`  ✗ public.${f.fn}: ${f.problem}`);
    process.exit(1);
  }
  console.log("check:security-definer OK");
}

main();
