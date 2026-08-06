// Visual regression for the trading-mode surfaces on small screens.
//
// The badge and the risk-controls header sit in a crowded row: an icon, a
// truncating title, the mode badge, and a chevron. On 320–414px phones this
// row has previously clipped ("Position Onl…"), wrapped the chevron onto its
// own line, or shrunk the badge until the icon overlapped the text.
//
// jsdom cannot measure pixels, so we lock the *layout contract* — the
// mobile-first Tailwind utilities that keep the row readable — plus full
// markup snapshots so any unreviewed structural change fails loudly.
//
// Breakpoint model (Tailwind defaults): base = phone (<640px), `sm:` = 640px+.
// An unprefixed class is phone behaviour; a `sm:` class is the desktop override.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { TradingModeBadge } from "../trading-mode-badge";
import { TradingModeDriftNotice } from "../trading-mode-drift-notice";

const html = (el: ReactElement) => renderToStaticMarkup(el);

/** Phone widths this contract targets; used to document intent in test names. */
const PHONE_WIDTHS = [320, 375, 414] as const;

const SWING = { trading_style: "swing" };
const POSITION = { trading_style: "position" };

/**
 * Mirror of the risk-controls card header row (src/components/risk-controls-card.tsx).
 * Rendering the real card needs a query client, server fns and a router, so the
 * header markup is mirrored here and the coverage gate
 * (src/lib/__tests__/trading-mode-surface-coverage.test.ts) keeps the wording in
 * lockstep. Keep the class lists identical to the card.
 */
function RiskPanelHeader({ riskConfig }: { riskConfig: unknown }) {
  const swing = (riskConfig as { trading_style?: string })?.trading_style === "swing";
  return (
    <div className="flex flex-row items-center justify-between gap-2 space-y-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
          <span className="flex min-w-0 items-center gap-2">
            <svg className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">Risk controls</span>
          </span>
          <TradingModeBadge riskConfig={riskConfig} />
        </div>
        <div>
          {swing ? "Swing horizon (days–weeks) · " : "Position horizon (months) · "}
          Stop-loss 6% · Take-profit 12%
        </div>
      </div>
      <svg className="h-4 w-4 text-muted-foreground transition-transform" />
    </div>
  );
}

describe("trading mode badge — small-screen visual regression", () => {
  for (const [label, cfg] of [
    ["swing", SWING],
    ["position", POSITION],
  ] as const) {
    describe(label, () => {
      const markup = html(<TradingModeBadge riskConfig={cfg} />);

      it("full markup snapshot", () => {
        expect(markup).toMatchSnapshot();
      });

      it.each(PHONE_WIDTHS)("stays on one line at %ipx (never wraps or clips)", () => {
        // A wrapping badge breaks the header row height on phones.
        expect(markup).toMatch(/\bwhitespace-nowrap\b/);
        // It must not be squeezed by the truncating title next to it.
        expect(markup).toMatch(/\bshrink-0\b/);
        // …but it must not push the row wider than the viewport either.
        expect(markup).toMatch(/\bmax-w-full\b/);
      });

      it.each(PHONE_WIDTHS)("uses the compact label at %ipx and the full label at sm:+", () => {
        // Phone: short word visible, long wording hidden until 640px.
        expect(markup).toMatch(/class="sm:hidden">(Swing|Position)</);
        expect(markup).toMatch(/class="hidden sm:inline">(Swing Active|Position Only)</);
      });

      it("scales type and padding up at sm:, never down", () => {
        // Base (phone) sizes are the smaller ones; sm: overrides are larger.
        expect(markup).toMatch(/\btext-\[10px\]\b/);
        expect(markup).toMatch(/\bsm:text-\[11px\]\b/);
        expect(markup).toMatch(/\bpx-1\.5\b/);
        expect(markup).toMatch(/\bsm:px-2\b/);
      });

      it("keeps the icon a fixed size so the label never overlaps it", () => {
        expect(markup).toMatch(/class="[^"]*h-3 w-3 shrink-0/);
        expect(markup).toMatch(/\bgap-1\b/);
      });

      it("has no fixed pixel width that could overflow a 320px row", () => {
        expect(markup).not.toMatch(/\bw-\[\d+px\]/);
        expect(markup).not.toMatch(/\bmin-w-\[\d{3,}px\]/);
      });
    });
  }
});

describe("risk-panel header — small-screen visual regression", () => {
  for (const [label, cfg] of [
    ["swing", SWING],
    ["position", POSITION],
  ] as const) {
    describe(label, () => {
      const markup = html(<RiskPanelHeader riskConfig={cfg} />);

      it("full markup snapshot", () => {
        expect(markup).toMatchSnapshot();
      });

      it.each(PHONE_WIDTHS)("title truncates instead of pushing the badge off at %ipx", () => {
        // Both the outer text column and the inner title span must be able to
        // shrink, otherwise the badge is forced out of the row.
        expect(markup).toMatch(/class="min-w-0"/);
        expect(markup).toMatch(/class="flex min-w-0 items-center gap-2"/);
        expect(markup).toMatch(/class="truncate">Risk controls</);
      });

      it.each(PHONE_WIDTHS)("badge is allowed to wrap under the title at %ipx", () => {
        // The title row wraps as a whole (title, then badge) rather than
        // clipping either — with a row gap so the two lines do not collide.
        expect(markup).toMatch(/\bflex-wrap\b/);
        expect(markup).toMatch(/\bgap-y-1\b/);
      });

      it("keeps the chevron pinned on the same row at every phone width", () => {
        // `flex-row` (not wrap) on the outer row + a shrinkable text column
        // means the chevron never drops to its own line.
        expect(markup).toMatch(/class="flex flex-row items-center justify-between gap-2/);
        expect(markup).not.toMatch(/class="flex flex-row[^"]*flex-wrap/);
      });

      it("words the horizon consistently with the badge", () => {
        const swing = cfg === SWING;
        expect(markup).toContain(swing ? "Swing horizon" : "Position horizon");
        expect(markup).toContain(swing ? "Swing Active" : "Position Only");
        expect(markup).not.toContain(swing ? "Position Only" : "Swing Active");
      });
    });
  }
});

describe("drift notice — small-screen visual regression", () => {
  // The notice only renders once the hook has detected drift, which needs a
  // client effect; SSR is intentionally empty so hydration never flips text.
  it("renders nothing during SSR", () => {
    expect(html(<TradingModeDriftNotice riskConfig={POSITION} portfolioId="pf" />)).toBe("");
  });

  it("source keeps the phone-first wrap contract", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(import.meta.dirname, "../trading-mode-drift-notice.tsx"),
      "utf8",
    );
    // Wrapping row, shrinkable message, fixed-size icon and dismiss button, and
    // phone-first type scale — the same rules the badge follows.
    expect(src).toContain("flex flex-wrap items-start gap-2");
    expect(src).toContain("min-w-0 flex-1");
    expect(src).toContain("h-3.5 w-3.5 shrink-0");
    expect(src).toContain("text-[11px] leading-snug");
    expect(src).toContain("sm:text-xs");
  });
});
