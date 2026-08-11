// Guard: nothing a chart paints — gridlines, reference/baseline rules, or the
// data series themselves — may render as black, near-black, or otherwise
// disappear into the plot background.
//
// Three failure modes this locks out:
//   1. Recharts' light-page defaults (#ccc grid, #666 axis, black legend text)
//      leaking through because a prop was omitted.
//   2. Inline literals (`fill="#22c55e"`, `stroke="hsl(0 84% 60%)"`) that dodge
//      the palette and its contrast budget entirely.
//   3. Weak theme tokens (`--border`, `--muted-foreground`) used as a series
//      or reference colour, where they fall under the 3:1 non-text bar.
//
// Contrast is evaluated against every dark surface tier a chart can sit on.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AXIS_LINE_STROKE,
  CHART_NEUTRAL_SERIES,
  CHART_ROLE,
  CHART_SEQUENCE,
  CHART_SERIES_COLORS,
  GRID_STROKE,
  REFERENCE_LINE,
  REFERENCE_LINE_STROKE,
} from "@/lib/chart-palette";
import { CATEGORY_COLORS } from "@/lib/global-events";
import { AA_NON_TEXT, contrastRatio, parseColor, relativeLuminance } from "@/lib/contrast";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "__tests__" ? [] : walk(p);
    return /\.tsx$/.test(p) ? [p] : [];
  });
}

const chartFiles = walk(SRC).filter((p) => readFileSync(p, "utf8").includes('from "recharts"'));
const rel = (p: string) => p.replace(SRC, "src");

// src/styles.css surface tiers (single dark palette).
const SURFACES = {
  background: "oklch(0.16 0.02 250)",
  card: "oklch(0.20 0.02 250)",
  raised: "oklch(0.24 0.02 250)",
  sunken: "oklch(0.14 0.02 250)",
} as const;

const FOREGROUND = "oklch(0.96 0.01 90)"; // --foreground

/** Alpha of a `color-mix(in oklab, var(--foreground) N%, transparent)` token. */
function alphaOf(token: string): number {
  const m = token.match(/var\(--foreground\)\s+(\d+)%/);
  if (!m) throw new Error(`token is not a foreground color-mix: ${token}`);
  return Number(m[1]) / 100;
}

/** Composite a translucent stroke over an opaque surface (sRGB source-over). */
function composite(fg: string, bg: string, alpha: number): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  const mix = (x: number, y: number) => Math.round(x * alpha + y * (1 - alpha));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(mix(f.r, b.r))}${hex(mix(f.g, b.g))}${hex(mix(f.b, b.b))}`;
}

describe("chart colours are never black", () => {
  it("no series, grid or reference colour is black or near-black", () => {
    const candidates = [
      ...CHART_SERIES_COLORS,
      ...Object.values(CATEGORY_COLORS),
      ...Object.entries(SURFACES).flatMap(([, bg]) => [
        composite(FOREGROUND, bg, alphaOf(GRID_STROKE)),
        composite(FOREGROUND, bg, alphaOf(AXIS_LINE_STROKE)),
        composite(FOREGROUND, bg, alphaOf(REFERENCE_LINE_STROKE)),
      ]),
    ];
    // Pure black has luminance 0; anything below the darkest surface tier
    // would be invisible on it.
    const floor = relativeLuminance(parseColor(SURFACES.sunken));
    const offenders = candidates.filter((c) => relativeLuminance(parseColor(c)) <= floor);
    expect(offenders).toEqual([]);
  });

  it("keeps OKABE_ITO.black out of every rendered chart role", () => {
    expect(CHART_SERIES_COLORS).not.toContain("#000000");
    expect([...CHART_SEQUENCE]).not.toContain("#000000");
    expect(Object.values(CHART_ROLE)).not.toContain("#000000");
  });

  it("never hardcodes a colour literal on a chart stroke or fill", () => {
    const offenders: string[] = [];
    for (const p of chartFiles) {
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/\b(?:stroke|fill)="(#|hsl|rgb|oklch|black)[^"]*"/g)) {
        offenders.push(`${rel(p)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("data series contrast", () => {
  for (const color of CHART_SERIES_COLORS) {
    for (const [name, bg] of Object.entries(SURFACES)) {
      it(`series ${color} clears ${AA_NON_TEXT}:1 on ${name}`, () => {
        expect(contrastRatio(color, bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      });
    }
  }

  it("neutral supporting series is light enough for dark surfaces", () => {
    for (const [name, bg] of Object.entries(SURFACES)) {
      expect(contrastRatio(CHART_NEUTRAL_SERIES, bg), name).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("event-overlay category hues clear the non-text bar", () => {
    for (const [cat, hue] of Object.entries(CATEGORY_COLORS)) {
      for (const [name, bg] of Object.entries(SURFACES)) {
        expect(contrastRatio(hue, bg), `${cat} on ${name}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    }
  });
});

// Charts whose reference lines ARE the data: per-event hues, and breakout
// level/target/stop rules that must read as up vs down, not as a neutral rule.
const SEMANTIC_REFERENCE_CHARTS = ["event-overlay.tsx", "breakout-overlay-chart.tsx"];

describe("reference lines", () => {
  it("every ReferenceLine spreads the shared REFERENCE_LINE token", () => {
    const offenders: string[] = [];
    for (const p of chartFiles) {
      if (SEMANTIC_REFERENCE_CHARTS.some((f) => p.endsWith(f))) continue;
      const src = readFileSync(p, "utf8");
      for (const tag of src.match(/<ReferenceLine\b[\s\S]*?\/>/g) ?? []) {
        if (!tag.includes("{...REFERENCE_LINE}") && !tag.includes("{...SAXO_REFERENCE_LINE}"))
          offenders.push(`${rel(p)}: ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no ReferenceLine re-styles its stroke with a weak token", () => {
    const offenders: string[] = [];
    for (const p of chartFiles) {
      if (SEMANTIC_REFERENCE_CHARTS.some((f) => p.endsWith(f))) continue;
      const src = readFileSync(p, "utf8");
      for (const tag of src.match(/<ReferenceLine\b[\s\S]*?\/>/g) ?? []) {
        if (/\b(stroke|strokeOpacity|opacity)=/.test(tag)) offenders.push(`${rel(p)}: ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sits above the grid and below the data in visual weight", () => {
    expect(REFERENCE_LINE.stroke).toBe(REFERENCE_LINE_STROKE);
    expect(alphaOf(GRID_STROKE)).toBeLessThan(alphaOf(REFERENCE_LINE_STROKE));
    expect(alphaOf(AXIS_LINE_STROKE)).toBeLessThan(alphaOf(REFERENCE_LINE_STROKE));
  });

  it("clears the 3:1 non-text bar on every surface", () => {
    for (const [name, bg] of Object.entries(SURFACES)) {
      const line = composite(FOREGROUND, bg, alphaOf(REFERENCE_LINE_STROKE));
      expect(contrastRatio(line, bg), name).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("rejects --border and --muted-foreground as rule colours", () => {
    // Both resolve too close to the surfaces to be seen as a baseline.
    for (const weak of ["oklch(0.30 0.02 250)", "oklch(0.62 0.02 250)"]) {
      const strong = composite(FOREGROUND, SURFACES.background, alphaOf(REFERENCE_LINE_STROKE));
      expect(contrastRatio(strong, SURFACES.background)).toBeGreaterThan(
        contrastRatio(weak, SURFACES.background),
      );
    }
  });
});
