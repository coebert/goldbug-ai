// Guards that every Recharts surface which renders *text* pins its colour to a
// theme token. Recharts' built-in defaults are a black axis/legend fill and a
// white tooltip panel with black text — both illegible on this app's dark
// theme, and both silently reintroduced whenever a new chart forgets the
// explicit style props. This test fails CI in that case.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

const chartFiles = walk(SRC).filter((f) => {
  if (f.includes("__tests__")) return false;
  return /from "recharts"/.test(readFileSync(f, "utf8"));
});

// Balanced-brace extraction of `attr={{ ... }}` occurrences.
function attrObjects(src: string, attr: string): string[] {
  const found: string[] = [];
  const needle = `${attr}={{`;
  let i = 0;
  for (;;) {
    const idx = src.indexOf(needle, i);
    if (idx < 0) break;
    let depth = 0;
    let end = -1;
    for (let j = idx + attr.length + 1; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    found.push(src.slice(idx, end + 1));
    i = end + 1;
  }
  return found;
}

const rel = (f: string) => f.slice(SRC.length + 1);
// A colour is acceptable when it resolves through a theme token, a palette
// constant, or a computed variable — never a hard-coded dark literal.
const TOKEN = /var\(--[a-z0-9-]+\)|[A-Z_]{3,}(?:\.[A-Za-z]+)?|chartTheme\.|[Cc]olor/;
const BLACKISH = /["'`](?:black|#0{3,6}|rgb\(\s*0\s*,\s*0\s*,\s*0)/i;

describe("chart legends, tooltips and axis labels use theme tokens", () => {
  it("found chart files to audit", () => {
    expect(chartFiles.length).toBeGreaterThan(10);
  });

  for (const file of chartFiles) {
    const src = readFileSync(file, "utf8");
    const name = rel(file);

    it(`${name}: no hsl(var(--token)) — the theme is authored in oklch`, () => {
      expect(src).not.toMatch(/hsl\(var\(--/);
    });

    it(`${name}: every <Legend> pins its text colour`, () => {
      const legends = src.match(/<Legend\b[^>]*?\/?>/gs) ?? [];
      for (const legend of legends) {
        // Spreading a shared legend preset (LEGEND_PROPS / SAXO_LEGEND_PROPS)
        // carries both the colour token and the responsive sizing.
        if (/\{\.\.\.[A-Z][A-Z0-9_]*_LEGEND_PROPS\}|\{\.\.\.LEGEND_PROPS\}/.test(legend)) continue;
        expect(legend, `bare <Legend> inherits black text in ${name}`).toMatch(
          /wrapperStyle=\{/,
        );
        const style = attrObjects(legend, "wrapperStyle")[0] ?? "";
        const usesConst = /wrapperStyle=\{[A-Z_]+\}/.test(legend);
        if (!usesConst) {
          expect(style, `<Legend> in ${name} has no colour token`).toMatch(/color:/);
          expect(style).toMatch(TOKEN);
        }
      }
    });

    it(`${name}: every axis/reference label declares a fill`, () => {
      for (const label of attrObjects(src, "label")) {
        // `style: AXIS_LABEL` is the shared axis-label preset; it carries
        // fontSize + fill: var(--foreground) already.
        if (/style:\s*(?:\{\s*\.\.\.)?[A-Z][A-Z0-9_]*_LABEL\b/.test(label)) {
          continue;
        }
        expect(label, `label without fill in ${name}: ${label}`).toMatch(/fill:/);
        expect(label, `label falls back to black in ${name}`).not.toMatch(BLACKISH);
        expect(label).toMatch(TOKEN);
      }
    });

    it(`${name}: every tooltip contentStyle declares background and colour`, () => {
      // Both shared tooltip surfaces carry background + colour: the generic
      // palette token and the Saxo-themed one.
      const usesConst = /contentStyle=\{(?:TOOLTIP_CONTENT_STYLE|SAXO_TOOLTIP_CONTENT)\}/.test(src);
      const objects = attrObjects(src, "contentStyle");
      if (!objects.length) {
        // Either no styled tooltip, or the shared constant is used.
        expect(usesConst || !/contentStyle=/.test(src)).toBe(true);
        return;
      }
      for (const style of objects) {
        // Spreading a shared tooltip token carries background + colour already.
        if (/\.\.\.[A-Z][A-Z0-9_]*/.test(style)) {
          expect(style).toMatch(TOKEN);
          continue;
        }
        expect(style, `tooltip without colour in ${name}`).toMatch(/color:/);
        expect(style, `tooltip without surface in ${name}`).toMatch(/background:/);
        expect(style).toMatch(TOKEN);
      }
    });
  }
});
