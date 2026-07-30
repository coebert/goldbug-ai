// Visual regression for the real-money equity tile.
//
// Renders <ModeSummaryTile> across a matrix of representative states
// (positive, negative, zero, large, tiny, empty) and locks the exact
// HTML via `toMatchSnapshot`. Any change to the tile's markup,
// classes, formatter config, sign prefixes, or sub-value ordering will
// fail this test — forcing a deliberate snapshot update.
//
// Additionally extracts and snapshots the headline / delta / sublabel
// substrings individually so a diff pinpoints which sub-value drifted.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeSummaryTile } from "@/routes/index";

function render(props: {
  money: number;
  pnl: number;
  pct: number;
  count: number;
}) {
  return renderToStaticMarkup(
    <ModeSummaryTile
      label="Real-money equity"
      sublabel="REAL · live Saxo"
      tone="real"
      money={props.money}
      pnl={props.pnl}
      pct={props.pct}
      count={props.count}
    />,
  );
}

// Pull the three text-bearing regions out of the tile so the snapshot
// diff highlights *which* sub-value drifted (headline vs delta vs
// sublabel) rather than a wall of full markup.
function extractParts(html: string) {
  const headline = html.match(
    /<div class="mt-1 truncate[^"]*"[^>]*>([^<]*)<\/div>/,
  )?.[1];
  const delta = html.match(/<span>([^<]*)<\/span>/)?.[1];
  const sublabel = html.match(
    /<div class="text-\[10px\] text-muted-foreground">([^<]*)<\/div>/,
  )?.[1];
  const emptyState = html.match(
    /<div class="mt-1 text-sm text-muted-foreground">([^<]*)<\/div>/,
  )?.[1];
  const tone = html.includes("text-success")
    ? "positive"
    : html.includes("text-destructive")
      ? "negative"
      : "none";
  return { headline, delta, sublabel, emptyState, tone };
}

const CASES = {
  "positive small": { money: 300.46, pnl: 0.46, pct: 0.153, count: 1 },
  "positive large grouped": { money: 12_345.67, pnl: 1_234.9, pct: 2.53, count: 2 },
  "positive zero-decimal percent": { money: 500, pnl: 25, pct: 5, count: 1 },
  "tiny positive rounds to zero": { money: 300.01, pnl: 0.01, pct: 0.003, count: 1 },
  "zero equity zero pnl": { money: 0, pnl: 0, pct: 0, count: 1 },
  "negative equity small": { money: -125.4, pnl: -20, pct: -13.79, count: 1 },
  "negative equity large grouped": { money: -12_345.67, pnl: -500.9, pct: -3.9, count: 1 },
  "negative pnl positive equity": { money: 280, pnl: -20, pct: -6.6666, count: 1 },
  "tiny negative rounds to zero": { money: 299.99, pnl: -0.01, pct: -0.003, count: 1 },
  "empty state": { money: 0, pnl: 0, pct: 0, count: 0 },
} as const;

describe("real-money equity tile — visual regression", () => {
  for (const [name, props] of Object.entries(CASES)) {
    it(`full markup snapshot: ${name}`, () => {
      expect(render(props)).toMatchSnapshot();
    });

    it(`sub-value parts snapshot: ${name}`, () => {
      expect(extractParts(render(props))).toMatchSnapshot();
    });
  }

  it("idempotent: two renders of the same props produce identical HTML", () => {
    const a = render(CASES["positive small"]);
    const b = render(CASES["positive small"]);
    expect(a).toBe(b);
  });

  it("headline is always present exactly once (positive, negative, zero)", () => {
    for (const props of [
      CASES["positive small"],
      CASES["negative equity small"],
      CASES["zero equity zero pnl"],
    ]) {
      const html = render(props);
      const matches = html.match(/mt-1 truncate/g) ?? [];
      expect(matches.length).toBe(1);
    }
  });

  it("empty state suppresses headline & delta entirely (no drift into '£NaN' territory)", () => {
    const parts = extractParts(render(CASES["empty state"]));
    expect(parts.headline).toBeUndefined();
    expect(parts.delta).toBeUndefined();
    expect(parts.emptyState).toBe("No real-money portfolios");
  });
});
