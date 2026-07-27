// Unit contract for the shared capital-adjusted % helper. Locks the
// invariants every equity-% surface in the app relies on. Includes a
// guard scan that fails CI if any source file re-derives the
// deposit-including formula (`pnl / previous`) inline.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  capitalAdjustedDenom,
  capitalAdjustedPct,
} from "../capital-adjusted-return";

describe("capitalAdjustedPct", () => {
  it("returns pnl / baseline when there are no flows", () => {
    expect(capitalAdjustedPct({ pnl: 100, baseline: 1000, netFlow: 0 })).toBe(10);
  });

  it("scales the denominator by cumulative flows (the £999k regression)", () => {
    // £11k trading gain after a £999k deposit on a £1k base must be
    // ~1.1%, not +1101%.
    const pct = capitalAdjustedPct({
      pnl: 11_000,
      baseline: 1_000,
      netFlow: 999_000,
    });
    expect(pct).toBeCloseTo(1.1, 6);
  });

  it("returns 0 for non-positive baseline (no division by zero)", () => {
    expect(capitalAdjustedPct({ pnl: 5, baseline: 0, netFlow: 100 })).toBe(0);
    expect(capitalAdjustedPct({ pnl: 5, baseline: -10, netFlow: 100 })).toBe(0);
  });

  it("falls back to baseline when a withdrawal collapses the denom", () => {
    // Baseline 1000, withdrawal 2000 → denomRaw = -1000 → fall back
    // to 1000 rather than producing negative-denominator gibberish.
    const pct = capitalAdjustedPct({
      pnl: 100,
      baseline: 1_000,
      netFlow: -2_000,
    });
    expect(pct).toBe(10);
  });

  it("returns 0 on non-finite inputs", () => {
    expect(capitalAdjustedPct({ pnl: Number.NaN, baseline: 100, netFlow: 0 })).toBe(0);
    expect(capitalAdjustedPct({ pnl: 10, baseline: Number.NaN, netFlow: 0 })).toBe(0);
    expect(capitalAdjustedPct({ pnl: 10, baseline: 100, netFlow: Number.NaN })).toBeCloseTo(10, 6);
    expect(capitalAdjustedPct({ pnl: Infinity, baseline: 100, netFlow: 0 })).toBe(0);
  });

  it("handles negative pnl symmetrically", () => {
    const pct = capitalAdjustedPct({
      pnl: -50,
      baseline: 1_000,
      netFlow: 0,
    });
    expect(pct).toBe(-5);
  });

  it("is arrangement-invariant: same net flow → same pct", () => {
    const a = capitalAdjustedPct({ pnl: 100, baseline: 1_000, netFlow: 500 });
    const b = capitalAdjustedPct({ pnl: 100, baseline: 1_000, netFlow: 500 });
    expect(a).toBe(b);
  });
});

describe("capitalAdjustedDenom", () => {
  it("returns baseline + netFlow when positive", () => {
    expect(capitalAdjustedDenom(1_000, 500)).toBe(1_500);
  });
  it("falls back to baseline when flows collapse the denom", () => {
    expect(capitalAdjustedDenom(1_000, -2_000)).toBe(1_000);
  });
  it("returns 0 for non-positive baseline", () => {
    expect(capitalAdjustedDenom(0, 500)).toBe(0);
    expect(capitalAdjustedDenom(-5, 500)).toBe(0);
  });
});

// -------------------------------------------------------------------
// Guard: no other source file may re-derive the deposit-including
// formula. Every equity-% surface must import from
// `capital-adjusted-return` (directly or transitively via
// mode-summary / deposit-adjusted-series / card-range-pct).
// -------------------------------------------------------------------

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) yield full;
  }
}

// Files that legitimately compute `pnl / previous` (or equivalent
// non-capital-adjusted math) and are allow-listed here with the
// reason. If you add a new equity-% surface, prefer capitalAdjustedPct
// — do NOT extend this list without explicit justification.
const ALLOWED_INLINE_DIVISION = new Set<string>([
  // Per-day pct is anchored to the previous snapshot's equity by
  // design (numerator already excludes flows within the day) — see
  // src/lib/daily-equity-changes.ts docstring.
  "src/lib/daily-equity-changes.ts",
  // Component decomposition: buckets must sum to totalChange /
  // startEquity by construction. See src/lib/equity-change-breakdown.ts.
  "src/lib/equity-change-breakdown.ts",
  // Sanity check on realised broker pnl vs prior equity — not a
  // user-facing % change surface.
  "src/lib/pnl-sanity.ts",
  // The helper itself.
  "src/lib/capital-adjusted-return.ts",
  // Mode summary intentionally keeps the raw pct branch behind
  // `includeDeposits: true` for the (rare) legacy caller that wants
  // it; the default (false) branch goes through capitalAdjustedPct.
  "src/lib/mode-summary.ts",
]);

// Pattern: any variant of `something / previous * 100` or
// `pnl / prevEquity` that could accidentally re-introduce the
// deposit-including formula.
const FORBIDDEN = [
  /\bpnl\s*\/\s*previous\b/,
  /\bdelta\s*\/\s*previous\s*\*\s*100/,
  /\/\s*prevEquity\s*\)?\s*\*\s*100/,
];

describe("guard: no accidental deposit-including % math", () => {
  it("no source file reintroduces `pnl / previous * 100` outside the allow-list", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOWED_INLINE_DIVISION.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      for (const pat of FORBIDDEN) {
        if (pat.test(src)) {
          offenders.push(`${rel} matches ${pat}`);
          break;
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
