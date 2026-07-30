// Regression tests: the same story filed in Cyrillic and in romanised Latin
// must dedupe to one reel row, and AI citations logged against either spelling
// must resolve to the same decision bucket.
//
// Wires romanise inconsistently (kh/h, zh/j, ts/c, y/i, -yy/-y endings), so the
// dedupe layer keys rows on a folded romanisation in addition to the literal
// normalised headline.

import { describe, expect, it } from "vitest";
import {
  buildSeenKeySet,
  dedupeKeysFor,
  dedupeNewsItems,
  filterUnseen,
  headlineTransliterationKeys,
  normalizeHeadlineKey,
} from "@/lib/news-dedupe";
import {
  foldRomanization,
  hasCyrillic,
  transliterateCyrillic,
  transliterationKey,
} from "@/lib/news-transliterate";

const tKey = (s: string) => transliterationKey(s, normalizeHeadlineKey);

const RU = "Газпром увеличил добычу газа на десять процентов";
const RU_ROMAN_BGN = "Gazprom uvelichil dobychu gaza na desyat protsentov";
const RU_ROMAN_ALT = "Gazprom uvelichil dobichu gaza na desiat procentov";
const RU_ROMAN_NOISY = "GAZPROM UVELICHIL DOBYCHU GAZA NA DESYAT PROTSENTOV!!";

const UA = "Харків отримав нову програму фінансування від банку";
const UA_ROMAN = "Kharkiv otrymav novu prohramu finansuvannya vid banku";
const UA_ROMAN_ALT = "Harkiv otrimav novu programu finansuvannia vid banku";

describe("transliteration primitives", () => {
  it("detects and romanises Cyrillic deterministically", () => {
    expect(hasCyrillic(RU)).toBe(true);
    expect(hasCyrillic(RU_ROMAN_BGN)).toBe(false);
    expect(transliterateCyrillic("Газпром")).toBe("gazprom");
    expect(transliterateCyrillic("Харків")).toBe("kharkiv");
    expect(transliterateCyrillic("Жуков")).toBe("zhukov");
    expect(transliterateCyrillic("Цена")).toBe("tsena");
  });

  it("folds competing romanisations of the same name together", () => {
    expect(foldRomanization("kharkiv")).toBe(foldRomanization("harkiv"));
    expect(foldRomanization("zhukov")).toBe(foldRomanization("jukov"));
    expect(foldRomanization("protsentov")).toBe(foldRomanization("procentov"));
    expect(foldRomanization("dobychu")).toBe(foldRomanization("dobichu"));
  });

  it("is idempotent and stays empty for scripts it cannot romanise", () => {
    const once = tKey(RU);
    expect(once.length).toBeGreaterThan(0);
    expect(tKey(once)).toBe(once);
    expect(tKey("央行宣布降准零点五个百分点")).toBe("");
    expect(tKey("Aramco تعلن أرباحاً قياسية")).toBe("");
  });

  it("refuses to key very short headlines, where a fold would over-match", () => {
    expect(tKey("Цена")).toBe("");
    expect(tKey("Oil up")).toBe("");
  });
});

describe("Cyrillic vs Latin transliteration: dedupe", () => {
  it("produces the same transliteration key for native, romanised and drifted spellings", () => {
    const base = tKey(RU);
    expect(tKey(RU_ROMAN_BGN)).toBe(base);
    expect(tKey(RU_ROMAN_ALT)).toBe(base);
    expect(tKey(RU_ROMAN_NOISY)).toBe(base);
  });

  it("handles Ukrainian kh/h and -ya/-ia romanisation splits", () => {
    const base = tKey(UA);
    expect(tKey(UA_ROMAN)).toBe(base);
    expect(tKey(UA_ROMAN_ALT)).toBe(base);
  });

  it("emits a shared t: key across spellings while keeping literal keys distinct", () => {
    const native = dedupeKeysFor({ headline: RU, url: null });
    const roman = dedupeKeysFor({ headline: RU_ROMAN_ALT, url: null });
    const shared = native.filter((k) => k.startsWith("t:") && roman.includes(k));
    expect(shared).toHaveLength(1);
    // The literal normalised keys legitimately differ — the t: key is what bridges them.
    expect(normalizeHeadlineKey(RU)).not.toBe(normalizeHeadlineKey(RU_ROMAN_ALT));
  });

  it("collapses the transliterated duplicates to the first-seen row", () => {
    const out = dedupeNewsItems([
      { id: "1", headline: RU, url: null },
      { id: "2", headline: RU_ROMAN_BGN, url: null },
      { id: "3", headline: RU_ROMAN_ALT, url: null },
      { id: "4", headline: UA, url: null },
      { id: "5", headline: UA_ROMAN_ALT, url: null },
    ]);
    expect(out.map((r) => r.id)).toEqual(["1", "4"]);
  });

  it("rejects a romanised re-arrival of a story already stored in Cyrillic", () => {
    const seen = buildSeenKeySet([{ headline: RU, url: null }]);
    expect(filterUnseen([{ headline: RU_ROMAN_ALT, url: null }], seen)).toHaveLength(0);
    expect(filterUnseen([{ headline: UA_ROMAN, url: null }], seen)).toHaveLength(1);
  });

  it("bridges a translated row's original-language headline to a romanised arrival", () => {
    const translated = {
      headline: "Gazprom raises gas output by ten percent",
      original_headline: RU,
      url: null,
    };
    expect(headlineTransliterationKeys(translated)).toContain(tKey(RU_ROMAN_BGN));
    const seen = buildSeenKeySet([translated]);
    expect(filterUnseen([{ headline: RU_ROMAN_ALT, url: null }], seen)).toHaveLength(0);
  });

  it("keeps genuinely different stories apart", () => {
    expect(tKey(RU)).not.toBe(tKey(UA));
    const out = dedupeNewsItems([
      { id: "a", headline: RU, url: null },
      { id: "b", headline: "Gazprom cut gas output by ten percent after sanctions", url: null },
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("is idempotent over repeated dedupe passes", () => {
    const items = [
      { id: "1", headline: RU, url: null },
      { id: "2", headline: RU_ROMAN_ALT, url: null },
      { id: "3", headline: UA_ROMAN, url: null },
    ];
    const once = dedupeNewsItems(items);
    expect(dedupeNewsItems(once)).toEqual(once);
    expect(dedupeNewsItems(dedupeNewsItems(items))).toEqual(once);
  });
});

// Mirrors the citation lookup in src/lib/news.functions.ts, including the
// transliteration fallback index.
function makeCitationIndex(citedHeadlines: Array<[string, string]>) {
  const literal = new Map<string, string>();
  const translit = new Map<string, string>();
  for (const [headline, decisionId] of citedHeadlines) {
    const h = normalizeHeadlineKey(headline);
    if (h) literal.set(h, decisionId);
    const t = tKey(headline);
    if (t) translit.set(t, decisionId);
  }
  return (row: { headline: string; original_headline?: string | null }) =>
    literal.get(normalizeHeadlineKey(row.headline)) ??
    (row.original_headline ? literal.get(normalizeHeadlineKey(row.original_headline)) : undefined) ??
    translit.get(tKey(row.headline)) ??
    (row.original_headline ? translit.get(tKey(row.original_headline)) : undefined);
}

describe("Cyrillic vs Latin transliteration: citation mapping", () => {
  it("maps a citation logged in Cyrillic onto a romanised reel row", () => {
    const match = makeCitationIndex([[RU, "decision-gazprom"]]);
    expect(match({ headline: RU_ROMAN_BGN })).toBe("decision-gazprom");
    expect(match({ headline: RU_ROMAN_ALT })).toBe("decision-gazprom");
  });

  it("maps a citation logged in romanised Latin onto the Cyrillic reel row", () => {
    const match = makeCitationIndex([[RU_ROMAN_ALT, "decision-gazprom"]]);
    expect(match({ headline: RU })).toBe("decision-gazprom");
  });

  it("resolves through the original-language headline after translation lands", () => {
    const match = makeCitationIndex([[RU_ROMAN_BGN, "decision-gazprom"]]);
    expect(
      match({
        headline: "Gazprom raises gas output by ten percent",
        original_headline: RU,
      }),
    ).toBe("decision-gazprom");
  });

  it("prefers the exact literal match when both indexes could answer", () => {
    const match = makeCitationIndex([
      [RU, "decision-native"],
      [UA, "decision-ua"],
    ]);
    expect(match({ headline: RU })).toBe("decision-native");
    expect(match({ headline: UA_ROMAN_ALT })).toBe("decision-ua");
  });

  it("does not map an unrelated story onto a transliterated bucket", () => {
    const match = makeCitationIndex([[RU, "decision-gazprom"]]);
    expect(match({ headline: UA })).toBeUndefined();
    expect(match({ headline: "Bank of England holds rates steady in October" })).toBeUndefined();
  });
});
