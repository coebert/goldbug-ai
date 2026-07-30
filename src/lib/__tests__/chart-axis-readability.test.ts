// Guard: every Recharts axis in the app must use the shared AXIS_TICK token
// (12px, --foreground) rather than an ad-hoc inline `tick={{ fontSize: N }}`.
// Recharts' default tick fill is #666, which fails WCAG AA on this app's dark
// surfaces, and sub-12px ticks are illegible on mobile. This test fails CI if
// a new chart reintroduces either problem.
//
// It also re-checks the token's own contrast so a theme edit can't silently
// push axis labels below AA.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AXIS_LINE,
  AXIS_LINE_STROKE,
  AXIS_TICK,
  GRID_PROPS,
  GRID_STROKE,
  TICK_LINE,
  TICK_LINE_STROKE,
} from "@/lib/chart-palette";
import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio, parseColor } from "@/lib/contrast";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === "__tests__" ? [] : walk(p);
    return /\.tsx$/.test(p) ? [p] : [];
  });
}

const chartFiles = walk(SRC).filter((p) => readFileSync(p, "utf8").includes("<YAxis"));

// Same surfaces as chart-palette-contrast.test.ts (src/styles.css tokens).
const SURFACES = {
  background: "oklch(0.16 0.02 250)",
  card: "oklch(0.20 0.02 250)",
  raised: "oklch(0.24 0.02 250)",
  sunken: "oklch(0.14 0.02 250)",
} as const;

const FOREGROUND = "oklch(0.96 0.01 90)"; // --foreground, what AXIS_TICK.fill resolves to

describe("chart axis readability", () => {
  it("finds chart components to check", () => {
    expect(chartFiles.length).toBeGreaterThan(5);
  });

  it("uses the shared AXIS_TICK token for every axis tick", () => {
    const offenders = chartFiles.filter((p) => /tick=\{\{/.test(readFileSync(p, "utf8")));
    expect(offenders.map((p) => p.replace(SRC, "src"))).toEqual([]);
  });

  it("never renders axis ticks below 12px", () => {
    expect(AXIS_TICK.fontSize).toBeGreaterThanOrEqual(12);
    const offenders: string[] = [];
    for (const p of chartFiles) {
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/fontSize:\s*(\d+)/g)) {
        if (Number(m[1]) < 12) offenders.push(`${p.replace(SRC, "src")}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives numeric y-axes enough width for wide currency ticks", () => {
    const offenders: string[] = [];
    for (const p of chartFiles) {
      const src = readFileSync(p, "utf8");
      for (const tag of src.match(/<YAxis\b[\s\S]*?\/>/g) ?? []) {
        if (/type=\{?"category"/.test(tag)) continue;
        const widths = [...tag.matchAll(/width=\{(?:isMobile \? )?(\d+)/g)].map((m) => Number(m[1]));
        if (widths.length === 0 || widths.some((w) => w < 56)) {
          offenders.push(p.replace(SRC, "src"));
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("axis tick colour clears WCAG AA on every dark surface", () => {
    expect(AXIS_TICK.fill).toBe("var(--foreground)");
    for (const [name, bg] of Object.entries(SURFACES)) {
      expect(contrastRatio(FOREGROUND, bg), name).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});

// ---------------------------------------------------------------------------
// Gridlines, axis lines and tick marks.
//
// Recharts defaults gridlines to #ccc and axis/tick lines to #666 — tuned for
// a white page. On this app's dark surfaces the axis frame vanishes while the
// grid glares, so every chart must spread the shared tokens instead.

/** Composite a translucent stroke over an opaque surface (sRGB source-over). */
function composite(fg: string, bg: string, alpha: number): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  const mix = (x: number, y: number) => Math.round(x * alpha + y * (1 - alpha));
  return `rgb(${mix(f.r, b.r)}, ${mix(f.g, b.g)}, ${mix(f.b, b.b)})`;
}

function alphaOf(token: string): number {
  const m = token.match(/var\(--foreground\)\s+(\d+)%/);
  if (!m) throw new Error(`token is not a foreground color-mix: ${token}`);
  return Number(m[1]) / 100;
}

describe("chart gridline and axis-line styling", () => {
  it("spreads GRID_PROPS on every CartesianGrid", () => {
    const offenders: string[] = [];
    for (const p of chartFiles) {
      const src = readFileSync(p, "utf8");
      for (const tag of src.match(/<CartesianGrid\b[\s\S]*?\/>/g) ?? []) {
        if (!tag.includes("{...GRID_PROPS}")) offenders.push(`${p.replace(SRC, "src")}: ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never re-styles a grid with an ad-hoc stroke or opacity", () => {
    const offenders: string[] = [];
    for (const p of chartFiles) {
      const src = readFileSync(p, "utf8");
      for (const tag of src.match(/<CartesianGrid\b[\s\S]*?\/>/g) ?? []) {
        if (/\b(stroke|strokeDasharray|strokeOpacity|opacity|className)=/.test(tag)) {
          offenders.push(`${p.replace(SRC, "src")}: ${tag}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pins axisLine and tickLine on every axis so neither falls back to #666", () => {
    const offenders: string[] = [];
    for (const p of chartFiles) {
      const src = readFileSync(p, "utf8");
      for (const tag of src.match(/<(?:X|Y)Axis\b[\s\S]*?\/>/g) ?? []) {
        if (!/axisLine=/.test(tag)) offenders.push(`${p.replace(SRC, "src")}: missing axisLine`);
        if (!/tickLine=/.test(tag)) offenders.push(`${p.replace(SRC, "src")}: missing tickLine`);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("derives grid, tick and axis rules from --foreground in a legible ladder", () => {
    expect(GRID_PROPS.stroke).toBe(GRID_STROKE);
    expect(GRID_PROPS.strokeDasharray).toBe("3 3");
    expect(AXIS_LINE.stroke).toBe(AXIS_LINE_STROKE);
    expect(TICK_LINE.stroke).toBe(TICK_LINE_STROKE);
    // grid recedes behind ticks, ticks behind the axis frame
    expect(alphaOf(GRID_STROKE)).toBeLessThan(alphaOf(TICK_LINE_STROKE));
    expect(alphaOf(TICK_LINE_STROKE)).toBeLessThan(alphaOf(AXIS_LINE_STROKE));
  });

  it("keeps the axis frame at or above the 3:1 non-text contrast bar", () => {
    for (const [name, bg] of Object.entries(SURFACES)) {
      const axis = composite(FOREGROUND, bg, alphaOf(AXIS_LINE_STROKE));
      expect(contrastRatio(axis, bg), `axis line on ${name}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("keeps gridlines visible but subordinate to the data", () => {
    for (const [name, bg] of Object.entries(SURFACES)) {
      const grid = composite(FOREGROUND, bg, alphaOf(GRID_STROKE));
      const ratio = contrastRatio(grid, bg);
      // perceptible against the plot background...
      expect(ratio, `grid on ${name}`).toBeGreaterThan(1.1);
      // ...without competing with axis labels or plotted series
      expect(ratio, `grid on ${name}`).toBeLessThan(AA_NON_TEXT);
    }
  });
});
