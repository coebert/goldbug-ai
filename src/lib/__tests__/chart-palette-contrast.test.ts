// Automated WCAG AA contrast checks for chart palette + axis tokens.
//
// Purpose: any future palette or theme edit that quietly drops a
// series/axis under WCAG AA against a real surface fails CI here,
// not in a manual review pass. If a check fires, either pick a
// different palette entry or restrict the offending role to
// non-critical/decorative use.
//
// Surfaces mirror src/styles.css. This project ships a single dark
// palette (`:root` and `.dark` blocks are identical), so we iterate
// the surface tiers charts actually render on.

import { describe, it, expect } from "vitest";
import {
  AA_LARGE_TEXT,
  AA_NON_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
} from "@/lib/contrast";
import { CHART_ROLE, CHART_SEQUENCE, OKABE_ITO } from "@/lib/chart-palette";

// Resolved from src/styles.css tokens. Keep in sync if the theme
// changes — the parser accepts the same syntax verbatim.
const SURFACES = {
  background: "oklch(0.16 0.02 250)", // page background / --surface-1
  card: "oklch(0.20 0.02 250)", // default card / --surface-2
  raised: "oklch(0.24 0.02 250)", // hover / --surface-3
  sunken: "oklch(0.14 0.02 250)", // inputs / --surface-sunken
} as const;

const FOREGROUND = "oklch(0.96 0.01 90)"; // --foreground; axis tick fill

// Palette entries that are only ever used with a bold, high-contrast
// text label overlay or as fill for large shapes. They must still
// clear the non-text 3:1 bar but are exempt from the 4.5:1 rule
// applied to small text/labels drawn *in* the same colour.
const NON_TEXT_ONLY_ROLES = new Set<string>([
  // Yellow #F0E442 fails 4.5:1 on dark surfaces; we only ever use it
  // as a warning fill under a text overlay, never as label text.
  OKABE_ITO.yellow,
]);

const isNonTextOnly = (hex: string) => NON_TEXT_ONLY_ROLES.has(hex);

describe("chart palette contrast (WCAG AA)", () => {
  describe("axis tick foreground vs every rendered surface", () => {
    for (const [name, bg] of Object.entries(SURFACES)) {
      it(`--foreground clears 4.5:1 on ${name}`, () => {
        const ratio = contrastRatio(FOREGROUND, bg);
        expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  });

  describe("semantic CHART_ROLE entries vs every rendered surface", () => {
    for (const [role, hex] of Object.entries(CHART_ROLE)) {
      for (const [surfaceName, bg] of Object.entries(SURFACES)) {
        const min = isNonTextOnly(hex) ? AA_NON_TEXT : AA_LARGE_TEXT;
        it(`${role} (${hex}) clears ${min}:1 on ${surfaceName}`, () => {
          const ratio = contrastRatio(hex, bg);
          expect(ratio).toBeGreaterThanOrEqual(min);
        });
      }
    }
  });

  describe("CHART_SEQUENCE entries vs every rendered surface", () => {
    for (const hex of CHART_SEQUENCE) {
      for (const [surfaceName, bg] of Object.entries(SURFACES)) {
        const min = isNonTextOnly(hex) ? AA_NON_TEXT : AA_LARGE_TEXT;
        it(`${hex} clears ${min}:1 on ${surfaceName}`, () => {
          const ratio = contrastRatio(hex, bg);
          expect(ratio).toBeGreaterThanOrEqual(min);
        });
      }
    }
  });

  it("adjacent CHART_SEQUENCE hues stay distinguishable (>= 1.3:1)", () => {
    // Adjacency contrast keeps stacked areas visually separable even
    // when they land in similar luminance bands.
    for (let i = 0; i < CHART_SEQUENCE.length - 1; i += 1) {
      const ratio = contrastRatio(CHART_SEQUENCE[i], CHART_SEQUENCE[i + 1]);
      expect(ratio).toBeGreaterThanOrEqual(1.3);
    }
  });
});
