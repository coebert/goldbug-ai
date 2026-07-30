// Regression tests for code-switched headlines — titles that mix scripts in a
// single string ("Сбербанк beats Q3 forecasts", "Toyota、円安で最高益", tickers
// and Latin brand names embedded in Cyrillic/CJK copy).
//
// Two invariants matter here:
//   1. Detection must not fall back to "latin"/English just because part of
//      the headline is ASCII — otherwise the row skips translation and gets
//      labelled wrongly in the reel.
//   2. Dedupe keys must retain BOTH scripts verbatim (minus punctuation), so
//      the same code-switched story arriving from another feed — or with
//      cosmetic drift — collapses onto one row, and AI citations still resolve.

import { describe, expect, it } from "vitest";
import {
  buildSeenKeySet,
  dedupeKeysFor,
  dedupeNewsItems,
  filterUnseen,
  normalizeHeadlineKey,
} from "@/lib/news-dedupe";
import { detectLanguage, detectScript, needsTranslation } from "@/lib/language-detect";

// Real-world shapes: Latin brand/ticker + non-Latin body.
const RU_LATIN = "Сбербанк (SBER) превысил прогноз по прибыли за Q3";
const RU_LATIN_VARIANT = "«Сбербанк» (SBER) — превысил  прогноз по прибыли за Q3.";
const UK_LATIN = "НБУ та IMF узгодили нову програму фінансування";
const JA_LATIN = "Toyota、円安で最高益を更新";
const ZH_LATIN = "PBOC 宣布降准 0.5 个百分点";
const KO_LATIN = "Samsung 삼성전자 영업이익 급증";
const EL_LATIN = "Alpha Bank ανακοίνωσε αύξηση κερδών";
const AR_LATIN = "Aramco تعلن أرباحاً قياسية";

describe("code-switched headlines: script detection", () => {
  it.each([
    ["Latin + Cyrillic (Russian)", RU_LATIN, "cyrillic"],
    ["Latin + Cyrillic (Ukrainian)", UK_LATIN, "cyrillic"],
    ["Latin + Kana/Kanji", JA_LATIN, "kana"],
    ["Latin + Han", ZH_LATIN, "han"],
    ["Latin + Hangul", KO_LATIN, "hangul"],
    ["Latin + Greek", EL_LATIN, "greek"],
    ["Latin + Arabic", AR_LATIN, "arabic"],
  ])("reports the non-Latin script for %s", (_label, headline, script) => {
    expect(detectScript(headline)).toBe(script);
    expect(detectLanguage(headline).script).toBe(script);
  });

  it("never treats a code-switched headline as English, however much Latin it carries", () => {
    for (const h of [RU_LATIN, UK_LATIN, JA_LATIN, ZH_LATIN, KO_LATIN, EL_LATIN, AR_LATIN]) {
      const d = detectLanguage(h);
      expect(d.isEnglish).toBe(false);
      expect(d.confidence).toBeGreaterThan(0.5);
      expect(needsTranslation(h)).toBe(true);
    }
  });

  it("keeps a leading English clause from flipping the verdict", () => {
    const d = detectLanguage("Reuters exclusive: Центробанк снизил ключевую ставку до 16%");
    expect(d.script).toBe("cyrillic");
    expect(d.isEnglish).toBe(false);
  });

  it("still reports English when the only non-ASCII part is an accented proper noun", () => {
    const d = detectLanguage("Nestlé and Société Générale post higher profits in the quarter");
    expect(d.script).toBe("latin");
    expect(d.isEnglish).toBe(true);
    expect(needsTranslation("Nestlé and Société Générale post higher profits in the quarter")).toBe(false);
  });

  it("resolves mixed non-Latin scripts by the documented priority (kana before han)", () => {
    // A Japanese headline quoting Chinese characters must not be read as Chinese.
    expect(detectScript("日銀、中国人民銀行の降准を受けてコメント")).toBe("kana");
    expect(detectLanguage("日銀、中国人民銀行の降准を受けてコメント").code).toBe("ja");
  });

  it("is stable across repeated detection and cosmetic drift", () => {
    const first = detectLanguage(RU_LATIN);
    const drift = detectLanguage(RU_LATIN_VARIANT);
    expect(drift.script).toBe(first.script);
    expect(drift.code).toBe(first.code);
    expect(drift.isEnglish).toBe(first.isEnglish);
    expect(drift.confidence).toBe(first.confidence);
  });
});

describe("code-switched headlines: dedupe keys", () => {
  it("preserves both scripts in the normalised key", () => {
    const key = normalizeHeadlineKey(RU_LATIN);
    expect(key).toContain("сбербанк");
    expect(key).toContain("sber");
    expect(key).toContain("q3");
    expect(key).not.toMatch(/[«»().]/);
  });

  it("collapses punctuation, case and spacing drift onto one key", () => {
    expect(normalizeHeadlineKey(RU_LATIN_VARIANT)).toBe(normalizeHeadlineKey(RU_LATIN));
    expect(normalizeHeadlineKey("TOYOTA、円安で最高益を更新!!")).toBe(normalizeHeadlineKey(JA_LATIN));
    expect(normalizeHeadlineKey("UPDATE 2-Samsung 삼성전자 영업이익 급증")).toBe(
      normalizeHeadlineKey(KO_LATIN),
    );
  });

  it("does not conflate visually similar Latin and Cyrillic homoglyphs", () => {
    // "PAP" in Latin vs "РАР" in Cyrillic are different stories.
    expect(normalizeHeadlineKey("PAP raises guidance")).not.toBe(
      normalizeHeadlineKey("РАР raises guidance"),
    );
  });

  it("keeps distinct code-switched stories distinct", () => {
    expect(normalizeHeadlineKey(RU_LATIN)).not.toBe(normalizeHeadlineKey(UK_LATIN));
  });

  it("is idempotent", () => {
    for (const h of [RU_LATIN, RU_LATIN_VARIANT, JA_LATIN, ZH_LATIN, KO_LATIN, EL_LATIN, AR_LATIN]) {
      const once = normalizeHeadlineKey(h);
      expect(normalizeHeadlineKey(once)).toBe(once);
    }
  });

  it("emits a stable key set for the same story arriving from two feeds", () => {
    const a = dedupeKeysFor({ headline: RU_LATIN, url: "https://www.example.com/ru/sber?utm_source=rss" });
    const b = dedupeKeysFor({ headline: RU_LATIN_VARIANT, url: "https://example.com/ru/sber/" });
    expect(a.sort()).toEqual(b.sort());
  });

  it("indexes a translated row under both its English and code-switched original keys", () => {
    const keys = dedupeKeysFor({
      headline: "Sberbank (SBER) beats third-quarter profit forecast",
      original_headline: RU_LATIN,
      url: null,
    });
    expect(keys).toContain(`h:${normalizeHeadlineKey(RU_LATIN)}`);
    expect(keys).toContain(`h:${normalizeHeadlineKey("Sberbank (SBER) beats third-quarter profit forecast")}`);
  });
});

describe("code-switched headlines: dedupe + citation behaviour", () => {
  it("collapses cosmetic variants to the first-seen row", () => {
    const out = dedupeNewsItems([
      { id: "1", headline: RU_LATIN, url: null },
      { id: "2", headline: RU_LATIN_VARIANT, url: null },
      { id: "3", headline: "  сбербанк  (sber)   превысил прогноз по прибыли за q3 ", url: null },
      { id: "4", headline: UK_LATIN, url: null },
    ]);
    expect(out.map((r) => r.id)).toEqual(["1", "4"]);
  });

  it("rejects a re-arrival in the source language after the translation is stored", () => {
    const seen = buildSeenKeySet([
      { headline: "Sberbank (SBER) beats third-quarter profit forecast", original_headline: RU_LATIN },
    ]);
    expect(filterUnseen([{ headline: RU_LATIN_VARIANT, url: null }], seen)).toHaveLength(0);
    expect(filterUnseen([{ headline: UK_LATIN, url: null }], seen)).toHaveLength(1);
  });

  it("matches AI citations logged against either side of a code-switched pair", () => {
    // Mirrors the citation lookup in src/lib/news.functions.ts.
    const matchCitation = (
      buckets: Map<string, string>,
      row: { headline: string; original_headline?: string | null },
    ) =>
      buckets.get(normalizeHeadlineKey(row.headline)) ??
      (row.original_headline ? buckets.get(normalizeHeadlineKey(row.original_headline)) : undefined);

    const buckets = new Map([[normalizeHeadlineKey(RU_LATIN_VARIANT), "decision-ru"]]);
    expect(
      matchCitation(buckets, {
        headline: "Sberbank (SBER) beats third-quarter profit forecast",
        original_headline: RU_LATIN,
      }),
    ).toBe("decision-ru");
    expect(matchCitation(buckets, { headline: UK_LATIN })).toBeUndefined();
  });
});
