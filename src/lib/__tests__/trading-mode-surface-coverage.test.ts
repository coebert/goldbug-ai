// CI gate: every UI surface that words the trading mode must be covered by the
// parity suite, and the strings the parity tests mirror must still exist
// verbatim in the components they mirror.
//
// Without this, someone can add a new card that renders "Position Only" from
// its own ad-hoc check, the parity tests keep passing, and the badge can drift
// from the engine again.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** Surfaces allowed to word the trading mode. Adding one? Cover it in the parity suite. */
const COVERED_SURFACES = new Set([
  "components/trading-mode-badge.tsx",
  "components/trading-mode-drift-notice.tsx",
  "components/swing-mode-toggle.tsx",
  "components/risk-controls-card.tsx",
]);

/** Wording that only a mode surface would contain. */
const MODE_WORDING = [/Swing Active/, /Position Only/, /Swing horizon/, /Position horizon/];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = [path.join(ROOT, "components"), path.join(ROOT, "routes")].flatMap((d) =>
  walk(d),
);

describe("trading-mode surface coverage (CI gate)", () => {
  it("no uncovered surface words the trading mode", () => {
    const offenders = sourceFiles
      .filter((f) => {
        const rel = path.relative(ROOT, f).replaceAll(path.sep, "/");
        if (COVERED_SURFACES.has(rel)) return false;
        const src = readFileSync(f, "utf8");
        return MODE_WORDING.some((re) => re.test(src));
      })
      .map((f) => path.relative(ROOT, f).replaceAll(path.sep, "/"));

    expect(
      offenders,
      `These files render trading-mode wording but are not in COVERED_SURFACES. Add parity coverage in src/components/__tests__/trading-mode-parity.test.tsx, then list them here:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the risk-panel summary strings the parity tests mirror still exist verbatim", () => {
    const card = readFileSync(path.join(ROOT, "components/risk-controls-card.tsx"), "utf8");
    expect(card).toContain('"Swing horizon (days–weeks) · "');
    expect(card).toContain('"Position horizon (months) · "');
  });

  it("the badge is the only place that maps a config to the mode label", () => {
    const badge = readFileSync(path.join(ROOT, "components/trading-mode-badge.tsx"), "utf8");
    expect(badge).toContain("export function isSwingActive");
    expect(badge).toContain("export function tradingModeLabel");
    // Other surfaces must resolve through the shared hook/store, not re-derive.
    for (const rel of ["components/swing-mode-toggle.tsx", "components/risk-controls-card.tsx"]) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).toMatch(/useTradingMode|TradingModeBadge/);
    }
  });
});
