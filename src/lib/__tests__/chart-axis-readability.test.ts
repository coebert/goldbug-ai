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
import { AXIS_TICK } from "@/lib/chart-palette";
import { AA_NORMAL_TEXT, contrastRatio } from "@/lib/contrast";

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
