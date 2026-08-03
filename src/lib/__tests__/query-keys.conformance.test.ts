import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { POLL, qk } from "@/lib/query-keys";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !full.endsWith("query-keys.ts")) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = walk("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** Families owned by the factory — a raw literal for these means drift. */
const OWNED = [
  "portfolios",
  "all-portfolios-equity",
  "portfolio",
  "holdings",
  "trades",
  "live-status",
  "live-audit",
  "live-trade-alert",
];

describe("query-key factory conformance", () => {
  it("keys are hierarchical so parent invalidation clears children", () => {
    expect(qk.portfolio.detail("abc").slice(0, 1)).toEqual(qk.portfolio.all());
    expect(qk.trades.forPortfolio("abc").slice(0, 1)).toEqual(qk.trades.all());
    expect(qk.holdings.forPortfolio("abc").slice(0, 1)).toEqual(qk.holdings.all());
  });

  it("list consumers share one cache entry", () => {
    expect(qk.portfolios.list()).toEqual(qk.portfolios.all());
  });

  it("no component writes a raw literal for an owned key family", () => {
    const offenders: string[] = [];
    for (const { path, text } of SOURCES) {
      for (const family of OWNED) {
        const re = new RegExp(`queryKey: \\[\\s*"${family}"`);
        if (re.test(text)) offenders.push(`${path} -> "${family}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("polling uses a declared tier, not an ad-hoc interval", () => {
    const allowed = new Set<string>([
      "POLL.LIVE",
      "POLL.SEMI_LIVE",
      "POLL.SLOW",
      "POLL.STATIC",
    ]);
    const tierValues = new Set<number | false>([
      POLL.LIVE,
      POLL.SEMI_LIVE,
      POLL.SLOW,
      POLL.STATIC,
    ]);
    expect(tierValues.size).toBe(4);
    // Every migrated literal that equals a tier duration must reference the tier.
    const offenders: string[] = [];
    for (const { path, text } of SOURCES) {
      for (const match of text.matchAll(/refetchInterval:\s*([^,\n}]+)/g)) {
        const raw = match[1]!.trim();
        if (allowed.has(raw)) continue;
        if (/^(60_000|5 \* 60_000|300_000|5 \* 60 \* 1000|15_000)$/.test(raw)) {
          offenders.push(`${path} -> ${raw}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
