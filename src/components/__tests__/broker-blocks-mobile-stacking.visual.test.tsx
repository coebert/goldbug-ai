// Locks the mobile-first stacked layout of the /broker-blocks cards.
//
// These cards render long broker symbols ("SGLN:xlon"), money strings and
// multi-word outcome badges. Any base-breakpoint multi-column grid, any
// `flex-row` header, or any non-wrapping token pushes the card past a 320px
// viewport and the whole page gains a horizontal scrollbar. Portrait AND
// landscape phones both bottom out at the base breakpoint for width, so the
// rule is simply: nothing multi-column before `sm:`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = {
  blocks: readFileSync("src/components/broker-suitability-blocks-card.tsx", "utf8"),
  tradeRecon: readFileSync("src/components/trade-reconciliation-report-card.tsx", "utf8"),
  ledgerRecon: readFileSync("src/components/holdings-fills-recon-card.tsx", "utf8"),
  page: readFileSync("src/routes/broker-blocks.tsx", "utf8"),
};

/** Every `grid-cols-*` that is NOT behind a responsive prefix. */
function baseGridCols(src: string): string[] {
  return [...src.matchAll(/(?<![a-z:])grid-cols-\[?[^\s"'`]*/g)]
    .map((m) => m[0])
    .filter((c) => c !== "grid-cols-1");
}

describe("broker-blocks cards — mobile stacking", () => {
  for (const [name, src] of Object.entries(FILES)) {
    it(`${name} declares no multi-column grid before the sm breakpoint`, () => {
      expect(baseGridCols(src)).toEqual([]);
    });

    it(`${name} never uses flex-row headers without a stacked base`, () => {
      const headers = [...src.matchAll(/<CardHeader className="([^"]*)"/g)].map((m) => m[1]);
      for (const h of headers) {
        expect(h).not.toMatch(/(?<![a-z:])flex-row/);
      }
    });
  }

  it("metric tiles stack label above value only from sm, sharing one baseline on mobile", () => {
    expect(FILES.tradeRecon).toMatch(
      /grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4/,
    );
    expect(FILES.tradeRecon).toMatch(
      /flex min-w-0 items-baseline justify-between gap-3 rounded-lg[^"]*sm:block/,
    );
  });

  it("ledger figures render as a stacked definition list, 3-up from sm", () => {
    expect(FILES.ledgerRecon).toMatch(
      /<dl className="mt-2 grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-3/,
    );
    expect(FILES.ledgerRecon).toMatch(/flex min-w-0 items-baseline justify-between gap-2 sm:block/);
  });

  it("symbols wrap instead of forcing the card wider than the viewport", () => {
    expect(FILES.ledgerRecon).toMatch(/break-all font-mono/);
    expect(FILES.tradeRecon).toMatch(/break-all font-mono/);
    expect(FILES.blocks).toMatch(/break-all font-mono/);
  });

  it("action buttons are full-width on mobile and inline from sm", () => {
    expect(FILES.blocks).toMatch(/grid grid-cols-1 gap-2 sm:flex sm:flex-wrap/);
    expect(FILES.blocks).toMatch(/w-full whitespace-normal[^"]*sm:w-auto/);
  });

  it("the page shell clips stray horizontal overflow and allows shrinking", () => {
    expect(FILES.page).toMatch(/min-h-screen overflow-x-hidden/);
    expect(FILES.page).toMatch(/<main className="mx-auto w-full min-w-0 max-w-4xl/);
  });
});
