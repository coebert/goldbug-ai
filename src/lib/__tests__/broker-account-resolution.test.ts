import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolvePortfolioBrokerLink,
  isBrokerBacked,
} from "@/lib/brokers/portfolio-broker-link.server";

/**
 * Broker account resolution across every surface that talks to Saxo.
 *
 * Regression context: `buildSaxoAdapter` used to fall back to the process-wide
 * SAXO_ACCOUNT_KEY whenever a portfolio didn't name its own account, so two
 * live_sim portfolios mirrored the same broker cash and holdings. Every sync,
 * order route, FX spot conversion and reconciliation path must now resolve the
 * portfolio's OWN account and refuse to act when it is missing.
 */

// Rows shaped exactly like each call site's `select(...)` projection.
const LINKED_HIGH_RISK = {
  id: "be68327c-e2fd-43b6-a7d1-e3c6862ea1b7",
  mode: "live_sim",
  broker: "saxo",
  broker_account_id: "IszXddWLvI--FLMt59JcDA==",
};
const LINKED_LIVE = {
  id: "7c825889-81a1-4c32-9087-26d3847be6b1",
  mode: "live_prod",
  broker: "saxo",
  broker_account_id: "GTFB25I1ficWMb4bgW3MRQ==",
};
const UNLINKED_BALANCED = {
  id: "d7567038-0241-42f2-83ea-95925a4073ed",
  mode: "live_sim",
  broker: null,
  broker_account_id: null,
};

/** Every surface that resolves an account before touching the broker. */
const SURFACES = [
  { name: "cash sync", file: "src/lib/live-cash-sync.server.ts" },
  { name: "holdings sync", file: "src/lib/live-holdings-sync.server.ts" },
  { name: "position reconcile", file: "src/lib/live-reconcile.server.ts" },
  { name: "order routing", file: "src/lib/live-executor.server.ts" },
] as const;

/** Surfaces that pass the portfolio's key straight into the adapter. */
const KEY_PASSING_SURFACES = [
  { name: "cash sync", file: "src/lib/live-cash-sync.server.ts" },
  { name: "holdings sync", file: "src/lib/live-holdings-sync.server.ts" },
  { name: "position reconcile", file: "src/lib/live-reconcile.server.ts" },
  { name: "order routing", file: "src/lib/live-executor.server.ts" },
  { name: "FX spot conversion", file: "src/lib/fx-convert.functions.ts" },
  { name: "order status reconciliation", file: "src/lib/live.functions.ts" },
  { name: "reconciliation backfill", file: "src/lib/order-reconciliation-backfill.functions.ts" },
  { name: "hourly run reconcile", file: "src/lib/hourly-run.server.ts" },
] as const;

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("broker account resolution — missing broker_account_id", () => {
  it("refuses to resolve an account for an unlinked portfolio", () => {
    const link = resolvePortfolioBrokerLink(UNLINKED_BALANCED);
    expect(link.linked).toBe(false);
    if (!link.linked) expect(link.reason).toMatch(/simulated ledger/i);
  });

  it("refuses when the broker is set but the account id is missing or blank", () => {
    for (const broker_account_id of [null, undefined, "", " ", "\t\n"]) {
      const link = resolvePortfolioBrokerLink({ broker: "saxo", broker_account_id });
      expect(link.linked, `broker_account_id=${JSON.stringify(broker_account_id)}`).toBe(false);
      if (!link.linked) expect(link.reason).toMatch(/broker_account_id|default account/i);
    }
  });

  it("never leaks an accountKey field when unlinked", () => {
    const link = resolvePortfolioBrokerLink({ broker: "saxo", broker_account_id: null });
    expect(Object.keys(link).sort()).toEqual(["linked", "reason"]);
    expect((link as Record<string, unknown>).accountKey).toBeUndefined();
  });

  it("treats an account id with no broker as unlinked (no implicit Saxo)", () => {
    const link = resolvePortfolioBrokerLink({ broker: null, broker_account_id: "orphan-key" });
    expect(link.linked).toBe(false);
    expect(isBrokerBacked({ broker: "", broker_account_id: "orphan-key" })).toBe(false);
  });
});

describe("broker account resolution — mismatched or unsupported broker", () => {
  it("rejects a non-Saxo broker even when an account id is present", () => {
    for (const broker of ["ibkr", "alpaca", "SAXO_TEST", "saxobank"]) {
      const link = resolvePortfolioBrokerLink({ broker, broker_account_id: "k" });
      expect(link.linked, broker).toBe(false);
      if (!link.linked) expect(link.reason).toMatch(/unsupported broker/i);
    }
  });

  it("keeps two linked portfolios on distinct account keys", () => {
    const a = resolvePortfolioBrokerLink(LINKED_HIGH_RISK);
    const b = resolvePortfolioBrokerLink(LINKED_LIVE);
    expect(a.linked && b.linked).toBe(true);
    if (a.linked && b.linked) expect(a.accountKey).not.toBe(b.accountKey);
  });

  it("resolves the portfolio's key even when it differs from the env default", () => {
    // A "mismatch" against SAXO_ACCOUNT_KEY is normal and must be honoured —
    // the portfolio row is the source of truth, never the process env.
    const envDefault = "GTFB25I1ficWMb4bgW3MRQ==";
    const link = resolvePortfolioBrokerLink(LINKED_HIGH_RISK);
    expect(link.linked).toBe(true);
    if (link.linked) {
      expect(link.accountKey).toBe(LINKED_HIGH_RISK.broker_account_id);
      expect(link.accountKey).not.toBe(envDefault);
    }
  });

  it("normalises casing and padding without changing which account is chosen", () => {
    const padded = resolvePortfolioBrokerLink({
      broker: "  SaXo  ",
      broker_account_id: `  ${LINKED_HIGH_RISK.broker_account_id}  `,
    });
    expect(padded).toEqual({ linked: true, accountKey: LINKED_HIGH_RISK.broker_account_id });
  });

  it("is deterministic — repeated resolution never drifts", () => {
    const runs = Array.from({ length: 5 }, () => resolvePortfolioBrokerLink(LINKED_LIVE));
    expect(new Set(runs.map((r) => JSON.stringify(r))).size).toBe(1);
  });
});

describe("broker account resolution — call-site contracts", () => {
  it.each(SURFACES)("$name refuses to run when the portfolio is unlinked", ({ file }) => {
    const src = read(file);
    expect(src).toContain("resolvePortfolioBrokerLink");
    // Each surface must bail out on the unlinked branch rather than continuing
    // with a default account.
    expect(/if\s*\(!\s*(link|brokerLink)\.linked\)/.test(src)).toBe(true);
  });

  it.each(KEY_PASSING_SURFACES)("$name scopes the adapter with accountKey", ({ file }) => {
    const src = read(file);
    expect(src).toContain("buildSaxoAdapter");
    expect(src).toContain("accountKey");
  });

  it.each(KEY_PASSING_SURFACES)("$name selects broker_account_id from the portfolio row", ({ file }) => {
    expect(read(file)).toContain("broker_account_id");
  });

  it("no buildSaxoAdapter call for an already-linked portfolio omits accountKey", () => {
    for (const { file } of KEY_PASSING_SURFACES) {
      const src = read(file);
      const calls = [...src.matchAll(/buildSaxoAdapter\(\{[\s\S]*?\}\)/g)];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const m of calls) {
        const call = m[0];
        // Two legitimate exemptions:
        //  - account-agnostic probes (`portfolioId: null`), and
        //  - activation-time discovery, which pings to LEARN the account id
        //    and then writes it to broker_account_id.
        const agnostic = /portfolioId:\s*null/.test(call);
        const discovery = /ping\.accountId/.test(src.slice(m.index ?? 0, (m.index ?? 0) + 600));
        expect(agnostic || discovery || call.includes("accountKey"), `${file}: ${call}`).toBe(true);
      }
    }
  });

  it("activation persists the discovered account id instead of relying on the env default", () => {
    const src = read("src/lib/live.functions.ts");
    expect(src).toContain("ping.accountId");
    expect(src).toContain("broker_account_id: brokerAccountId ?? null");
  });


  it("order routing logs a skip instead of silently routing to a default account", () => {
    const src = read("src/lib/live-executor.server.ts");
    expect(src).toContain("ROUTE_SKIPPED_NO_BROKER_ACCOUNT");
  });

  it("the adapter builder documents that callers must pass the portfolio's key", () => {
    const src = read("src/lib/brokers/saxo.server.ts");
    expect(src).toContain("accountKey?: string");
    // The portfolio's own key wins; the process-wide env var is only a fallback.
    expect(src).toContain("explicitKey ?? process.env.SAXO_ACCOUNT_KEY");
  });
});
