// Property-based fuzz tests for the news normalisation pipeline.
//
// Real feeds re-publish the same story with cosmetic drift: extra punctuation,
// smart quotes, wire prefixes, doubled/odd whitespace, and combining diacritics
// on Latin letters. Those variants must be invisible to:
//   * language/script detection,
//   * citation matching (AI-cited headline ↔ reel row),
//   * de-duplication (both the key set and `dedupeNewsItems`),
// and every normalisation step must be idempotent.
//
// fast-check generates the variants; each property is checked over many
// randomised cases rather than a handful of hand-picked strings.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  canonicalUrlKey,
  dedupeKeysFor,
  dedupeNewsItems,
  filterUnseen,
  buildSeenKeySet,
  normalizeHeadlineKey,
} from "@/lib/news-dedupe";
import { detectLanguage, detectScript } from "@/lib/language-detect";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Word pools per script, so a generated headline stays in one script family. */
const WORD_POOLS: Record<string, string[]> = {
  latin: ["fed", "holds", "rates", "steady", "inflation", "cools", "sterling", "rallies", "oil", "slips"],
  cjk: ["央行", "降准", "円安", "進行", "日銀", "政策", "삼성전자", "영업이익", "급증", "株価"],
  cyrillic: ["центробанк", "снизил", "ставку", "гривня", "стабілізувалася", "нафта", "подорожчала"],
};

const PUNCTUATION = [".", ",", "!", "?", ":", ";", "—", "–", "-", "…", "«", "»", "“", "”", "‘", "’", "'", '"', "(", ")", "[", "]", "／", "、", "。", "·"];
const WHITESPACE = [" ", "  ", "\t", "\n", "\u00a0", " \u2009", "\u3000"];
const WIRE_PREFIXES = ["UPDATE 2-", "EXCLUSIVE: ", "BREAKING - ", "ANALYSIS: ", "REFILE-", "WRAPUP 1-", "FACTBOX: ", "CORRECTED: "];
/** Combining marks — stripped by the NFKD pass in `normalizeHeadlineKey`. */
const COMBINING = ["\u0301", "\u0300", "\u0302", "\u0308", "\u0327", "\u030a"];

const scriptArb = fc.constantFrom("latin", "cjk", "cyrillic");

/** A plausible headline in a single script family (never empty). */
const headlineArb = scriptArb.chain((script) =>
  fc
    .array(fc.constantFrom(...WORD_POOLS[script]), { minLength: 3, maxLength: 7 })
    .map((words) => ({ script, headline: words.join(script === "cjk" ? "" : " ") })),
);

/**
 * Cosmetic variant of a headline: the same letters and digits in the same
 * order, wrapped in randomised punctuation, whitespace, a wire prefix, and
 * (for Latin text) combining diacritics. `normalizeHeadlineKey` must map every
 * variant of a headline onto the same key.
 */
function variantArb(headline: string, script: string) {
  return fc
    .record({
      prefix: fc.option(fc.constantFrom(...WIRE_PREFIXES), { nil: "" }),
      lead: fc.constantFrom(...WHITESPACE, ""),
      trail: fc.constantFrom(...WHITESPACE, ""),
      punct: fc.array(fc.constantFrom(...PUNCTUATION), { maxLength: 4 }),
      upper: fc.boolean(),
      combining: fc.array(fc.constantFrom(...COMBINING), { maxLength: 3 }),
      gapSeed: fc.array(fc.constantFrom(...WHITESPACE), { maxLength: 6 }),
    })
    .map(({ prefix, lead, trail, punct, upper, combining, gapSeed }) => {
      // Re-space the existing word boundaries with random whitespace runs —
      // never split a word, so the letter sequence is preserved.
      const parts = headline.split(" ");
      let body = parts
        .map((p, i) => (i === 0 ? p : `${gapSeed[i % Math.max(1, gapSeed.length)] ?? " "}${p}`))
        .join("");
      if (upper) body = body.toUpperCase();
      // Combining marks only make sense on Latin base letters.
      if (script === "latin" && combining.length > 0) {
        let k = 0;
        body = body.replace(/\p{Script=Latin}/gu, (ch) =>
          k < combining.length && Math.random() < 0.35 ? `${ch}${combining[k++]}` : ch,
        );
      }
      return `${lead}${prefix}${body}${punct.join("")}${trail}`;
    });
}

const headlineWithVariantsArb = headlineArb.chain(({ script, headline }) =>
  fc
    .array(variantArb(headline, script), { minLength: 2, maxLength: 5 })
    .map((variants) => ({ script, headline, variants: [headline, ...variants] })),
);

const urlArb = fc
  .record({
    host: fc.constantFrom("example.com", "www.example.com", "News.Example.COM"),
    path: fc.constantFrom("/markets/story", "/markets/story/", "/Markets/Story"),
    query: fc.constantFrom("", "?utm_source=rss", "?utm_source=rss&utm_medium=feed", "?ref=twitter"),
    hash: fc.constantFrom("", "#top", "#comments"),
  })
  .map(({ host, path, query, hash }) => `https://${host}${path}${query}${hash}`);

const RUNS = { numRuns: 250 } as const;

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("normalizeHeadlineKey (property)", () => {
  it("is idempotent", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, ({ variants }) => {
        for (const v of variants) {
          const once = normalizeHeadlineKey(v);
          expect(normalizeHeadlineKey(once)).toBe(once);
        }
      }),
      RUNS,
    );
  });

  it("collapses punctuation / whitespace / diacritic / wire-prefix variants onto one key", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, ({ headline, variants }) => {
        const base = normalizeHeadlineKey(headline);
        expect(base.length).toBeGreaterThan(0);
        for (const v of variants) expect(normalizeHeadlineKey(v)).toBe(base);
      }),
      RUNS,
    );
  });

  it("never emits leading/trailing or repeated whitespace", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, ({ variants }) => {
        for (const v of variants) {
          const key = normalizeHeadlineKey(v);
          expect(key).toBe(key.trim());
          expect(key).not.toMatch(/\s{2,}/);
        }
      }),
      RUNS,
    );
  });

  it("keeps distinct stories distinct", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, headlineWithVariantsArb, (a, b) => {
        fc.pre(normalizeHeadlineKey(a.headline) !== normalizeHeadlineKey(b.headline));
        for (const va of a.variants) {
          for (const vb of b.variants) {
            expect(normalizeHeadlineKey(va)).not.toBe(normalizeHeadlineKey(vb));
          }
        }
      }),
      RUNS,
    );
  });
});

describe("language detection (property)", () => {
  it("reports the same script for every cosmetic variant", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, ({ headline, variants }) => {
        const base = detectScript(headline);
        for (const v of variants) expect(detectScript(v)).toBe(base);
      }),
      RUNS,
    );
  });

  it("is idempotent for detection on the normalised form of any variant", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, ({ variants }) => {
        const keys = variants.map((v) => normalizeHeadlineKey(v));
        const first = detectLanguage(keys[0]);
        for (const k of keys) {
          const d = detectLanguage(k);
          expect(d.script).toBe(first.script);
          expect(d.code).toBe(first.code);
          expect(d.isEnglish).toBe(first.isEnglish);
          expect(d.confidence).toBe(first.confidence);
        }
      }),
      RUNS,
    );
  });

  it("never flags a non-Latin headline as English, whatever the punctuation", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, ({ script, variants }) => {
        fc.pre(script !== "latin");
        for (const v of variants) {
          const d = detectLanguage(v);
          expect(d.isEnglish).toBe(false);
          expect(d.confidence).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });
});

// Mirrors the citation lookup in src/lib/news.functions.ts.
function matchCitation(
  buckets: Map<string, string>,
  row: { headline: string; original_headline?: string | null },
): string | undefined {
  return (
    buckets.get(normalizeHeadlineKey(row.headline)) ??
    (row.original_headline ? buckets.get(normalizeHeadlineKey(row.original_headline)) : undefined)
  );
}

describe("citation matching (property)", () => {
  it("matches whichever variant the AI cited against whichever variant the reel holds", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, fc.nat(), fc.nat(), ({ variants }, i, j) => {
        const cited = variants[i % variants.length];
        const rowHeadline = variants[j % variants.length];
        const buckets = new Map([[normalizeHeadlineKey(cited), "decision-1"]]);
        expect(matchCitation(buckets, { headline: rowHeadline })).toBe("decision-1");
      }),
      RUNS,
    );
  });

  it("matches through the original-language headline after a translation lands", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, fc.nat(), ({ variants }, i) => {
        const buckets = new Map([[normalizeHeadlineKey(variants[i % variants.length]), "decision-2"]]);
        expect(
          matchCitation(buckets, {
            headline: "Central bank cuts reserve requirement ratio",
            original_headline: variants[(i + 1) % variants.length],
          }),
        ).toBe("decision-2");
      }),
      RUNS,
    );
  });

  it("does not match an unrelated story", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, headlineWithVariantsArb, (a, b) => {
        fc.pre(normalizeHeadlineKey(a.headline) !== normalizeHeadlineKey(b.headline));
        const buckets = new Map([[normalizeHeadlineKey(a.headline), "decision-a"]]);
        expect(matchCitation(buckets, { headline: b.variants[0] })).toBeUndefined();
      }),
      RUNS,
    );
  });
});

describe("canonicalUrlKey (property)", () => {
  it("is idempotent and ignores host case, www, tracking params and trailing slashes", () => {
    fc.assert(
      fc.property(urlArb, urlArb, (a, b) => {
        const ka = canonicalUrlKey(a);
        expect(canonicalUrlKey(`https://${ka}`)).toBe(ka);
        expect(ka).toBe(canonicalUrlKey(b));
      }),
      RUNS,
    );
  });
});

describe("dedupeNewsItems (property)", () => {
  it("collapses cosmetic variants to a single row and is idempotent", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, (spec) => {
        const items = spec.variants.map((headline, i) => ({ id: `v${i}`, headline, url: null }));
        const once = dedupeNewsItems(items);
        expect(once).toHaveLength(1);
        // First occurrence wins — ordering is preserved.
        expect(once[0].id).toBe("v0");
        expect(dedupeNewsItems(once)).toEqual(once);
        expect(dedupeNewsItems(dedupeNewsItems(items))).toEqual(once);
      }),
      RUNS,
    );
  });

  it("keeps distinct stories and stays idempotent on mixed batches", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, headlineWithVariantsArb, (a, b) => {
        fc.pre(normalizeHeadlineKey(a.headline) !== normalizeHeadlineKey(b.headline));
        const items = [
          ...a.variants.map((headline, i) => ({ id: `a${i}`, headline, url: null })),
          ...b.variants.map((headline, i) => ({ id: `b${i}`, headline, url: null })),
        ];
        const once = dedupeNewsItems(items);
        expect(once.map((x) => x.id)).toEqual(["a0", "b0"]);
        expect(dedupeNewsItems(once)).toEqual(once);
      }),
      RUNS,
    );
  });

  it("produces a stable key set across variants, and filterUnseen rejects re-arrivals", () => {
    fc.assert(
      fc.property(headlineWithVariantsArb, urlArb, (spec, url) => {
        const rows = spec.variants.map((headline) => ({ headline, url }));
        const keySets = rows.map((r) => dedupeKeysFor(r).sort());
        for (const ks of keySets) expect(ks).toEqual(keySets[0]);

        const seen = buildSeenKeySet([rows[0]]);
        expect(filterUnseen(rows.slice(1), seen)).toHaveLength(0);
        // Idempotent: re-filtering an already-empty batch changes nothing.
        expect(filterUnseen(filterUnseen(rows.slice(1), seen), seen)).toHaveLength(0);
      }),
      RUNS,
    );
  });
});
