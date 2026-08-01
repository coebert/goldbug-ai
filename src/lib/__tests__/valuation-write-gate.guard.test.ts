// Guard: `equity_snapshots` may only be written through the valuation gate.
//
// The app previously had seven independent snapshot writers, each with its own
// copy of the units/FX rules. This test fails the suite the moment an eighth
// appears, which is what stops the class of bug from coming back.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** Modules allowed to persist equity snapshots directly. */
const ALLOWED = new Set([
  // the gate itself
  "lib/valuation/write-snapshot.server.ts",
  // Broker-authoritative writer that must do read-then-update rather than an
  // upsert so it stays correct without UNIQUE(portfolio_id, snapshot_date).
  // It runs the same invariant check and stamps the same `source`.
  "lib/live-cash-sync.server.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("equity_snapshots write gate", () => {
  it("has no writer outside the gate", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (!src.includes('from("equity_snapshots")')) continue;

      // Flag only VALUE-PRODUCING writes. Reads (`.select`) and destructive
      // resets (`.delete`, used by backtest/risk teardown) are unrestricted —
      // they cannot introduce a wrong number.
      const chains = src.split('from("equity_snapshots")').slice(1);
      for (const chain of chains) {
        const head = chain.slice(0, 400);
        if (/^\s*\.?\s*(insert|upsert|update)\s*\(/.test(head)) {
          offenders.push(`${rel}: .${/(insert|upsert|update)/.exec(head)![1]}()`);
        }
      }
    }

    expect(offenders, `Write equity snapshots via writeEquitySnapshot() instead:\n${offenders.join("\n")}`).toEqual([]);
  });
});
