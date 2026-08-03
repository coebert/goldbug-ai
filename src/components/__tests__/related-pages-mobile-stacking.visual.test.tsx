// Extends the /broker-blocks mobile-stacking contract to the neighbouring
// operational pages: the reconciliation detail views (cash reconciliation
// log, cash-sync reconciliation, intended-vs-executed, execution quality,
// rejection audit log) and the portfolio selector surfaces (/admin, /trades,
// /saxo-status, /hedge-fallbacks).
//
// Rules locked here:
//  1. No grid with 3+ columns at the base breakpoint — long money/symbol
//     strings squeeze or push the card past a 320px viewport.
//  2. No `flex-row` CardHeader without a stacked base — the header action
//     (badge/refresh/window switcher) must drop below the title on mobile.
//  3. Every page shell clips stray horizontal overflow and allows shrinking.
//  4. Wide tables must sit inside an `overflow-x-auto` wrapper, never widen
//     the page itself.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

const CARDS = {
  cashReconLog: "src/components/cash-reconciliation-log-card.tsx",
  cashSyncRecon: "src/components/cash-sync-reconciliation-card.tsx",
  intendedVsExecuted: "src/components/intended-vs-executed-card.tsx",
  executionQuality: "src/components/execution-quality-card.tsx",
  rejectionAuditLog: "src/components/broker-block-audit-log-card.tsx",
  runPortfolioStatus: "src/components/admin/run-portfolio-status-table.tsx",
  reconcileFills: "src/components/reconcile-fills-card.tsx",
} as const;

const PAGES = {
  admin: "src/routes/admin.tsx",
  trades: "src/routes/trades.tsx",
  saxoStatus: "src/routes/saxo-status.tsx",
  hedgeFallbacks: "src/routes/hedge-fallbacks.tsx",
} as const;

/** Every `grid-cols-*` that is NOT behind a responsive prefix. */
function baseGridCols(src: string): string[] {
  return [...src.matchAll(/(?<![a-z:])grid-cols-\[?[^\s"'`]*/g)].map((m) => m[0]);
}

function columnCount(cls: string): number {
  const m = /^grid-cols-(\d+)$/.exec(cls);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY; // arbitrary values are opaque → treat as wide
}

describe("reconciliation details + portfolio selector — mobile stacking", () => {
  for (const [name, path] of Object.entries({ ...CARDS, ...PAGES })) {
    const src = read(path);

    it(`${name} declares no 3+ column grid at the base breakpoint`, () => {
      const wide = baseGridCols(src).filter((c) => columnCount(c) >= 3);
      expect(wide).toEqual([]);
    });

    it(`${name} never uses flex-row headers without a stacked base`, () => {
      const headers = [...src.matchAll(/<CardHeader className="([^"]*)"/g)].map((m) => m[1]);
      for (const h of headers) {
        expect(h).not.toMatch(/(?<![a-z:])flex-row/);
      }
    });

    it(`${name} only forces a min-width inside a horizontally scrollable wrapper`, () => {
      const forced = [...src.matchAll(/min-w-\[[0-9]+px\]/g)].map((m) => m[0]);
      if (forced.length > 0) expect(src).toMatch(/overflow-x-auto/);
    });
  }

  for (const [name, path] of Object.entries(PAGES)) {
    const src = read(path);
    it(`${name} page shell clips horizontal overflow and allows shrinking`, () => {
      expect(src).toMatch(/overflow-x-hidden/);
      expect(src).toMatch(/min-w-0/);
    });
  }

  it("the admin portfolio selector truncates names instead of widening the row", () => {
    const src = read(PAGES.admin);
    expect(src).toMatch(/<label key=\{p\.id\} className="flex min-w-0 items-center gap-2 text-sm">/);
    expect(src).toMatch(/<span className="min-w-0 flex-1 truncate">\{p\.name\}<\/span>/);
  });

  it("the admin header nav wraps on mobile instead of pinning shrink-0", () => {
    expect(read(PAGES.admin)).toMatch(/flex flex-wrap items-center gap-2 sm:shrink-0/);
  });
});
