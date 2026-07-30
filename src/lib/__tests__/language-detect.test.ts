import { describe, expect, it } from "vitest";

import { detectLanguage, detectScript, needsTranslation } from "@/lib/language-detect";
import { dedupeNewsItems, normalizeHeadlineKey } from "@/lib/news-dedupe";

describe("detectScript", () => {
  it("identifies non-Latin scripts", () => {
    expect(detectScript("央行维持利率不变")).toBe("han");
    expect(detectScript("日銀は金利を据え置き")).toBe("kana");
    expect(detectScript("한국은행 금리 동결")).toBe("hangul");
    expect(detectScript("ЦБ сохранил ставку")).toBe("cyrillic");
    expect(detectScript("البنك المركزي يبقي الفائدة")).toBe("arabic");
    expect(detectScript("Fed holds rates steady")).toBe("latin");
  });
});

describe("detectLanguage", () => {
  it("treats plain English headlines as English", () => {
    for (const h of [
      "Fed holds rates steady as inflation cools",
      "Oil slips after OPEC signals output rise",
      "UK GDP grows 0.3% in the second quarter",
    ]) {
      const d = detectLanguage(h);
      expect(d.isEnglish, h).toBe(true);
      expect(needsTranslation(h)).toBe(false);
    }
  });

  it("flags Latin-script non-English headlines that carry no diacritics", () => {
    // The old non-ASCII gate missed every one of these.
    const cases: Array<[string, string]> = [
      ["El banco central mantiene los tipos para contener la inflacion", "Spanish"],
      ["Governo aprova novo imposto sobre as empresas do setor", "Portuguese"],
      ["Le gouvernement presente un plan pour les entreprises", "French"],
      ["Die Regierung plant eine neue Steuer fur Unternehmen", "German"],
    ];
    for (const [headline, name] of cases) {
      const d = detectLanguage(headline);
      expect(d.isEnglish, headline).toBe(false);
      expect(d.name, headline).toBe(name);
      expect(needsTranslation(headline)).toBe(true);
    }
  });

  it("flags non-Latin scripts with high confidence", () => {
    const d = detectLanguage("央行维持利率不变");
    expect(d.isEnglish).toBe(false);
    expect(d.name).toBe("Chinese");
    expect(d.confidence).toBeGreaterThan(0.9);
  });

  it("does not flag English headlines containing foreign proper nouns", () => {
    for (const h of [
      "Banco do Brasil posts a record annual profit",
      "Société Générale shares rise after the results beat",
      "Zürich insurer lifts its outlook for the year",
    ]) {
      expect(detectLanguage(h).isEnglish, h).toBe(true);
    }
  });

  it("is stable and never throws on empty or junk input", () => {
    expect(detectLanguage("").isEnglish).toBe(true);
    expect(detectLanguage(null).isEnglish).toBe(true);
    expect(detectLanguage("!!! ??? ---").isEnglish).toBe(true);
    const twice = [detectLanguage("Il governo approva la nuova legge"), detectLanguage("Il governo approva la nuova legge")];
    expect(twice[0]).toEqual(twice[1]);
  });
});

describe("cross-language dedupe", () => {
  it("keeps a usable key for non-Latin headlines", () => {
    expect(normalizeHeadlineKey("央行维持利率不变")).not.toBe("");
    expect(normalizeHeadlineKey("ЦБ сохранил ставку!")).toBe("цб сохранил ставку");
  });

  it("collapses the original-language copy against the translated copy", () => {
    const items = [
      {
        headline: "Central bank holds rates steady",
        url: "https://en.example.com/a",
        original_headline: "El banco central mantiene los tipos",
      },
      // Same story re-ingested in its source language from another domain.
      { headline: "El banco central mantiene los tipos", url: "https://es.example.com/b", original_headline: null },
    ];
    const out = dedupeNewsItems(items);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe("Central bank holds rates steady");
  });

  it("does not collapse genuinely different non-Latin headlines", () => {
    const out = dedupeNewsItems([
      { headline: "央行维持利率不变", url: "https://cn.example.com/1" },
      { headline: "石油价格上涨", url: "https://cn.example.com/2" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("collapses the same non-Latin headline arriving twice from different URLs", () => {
    const out = dedupeNewsItems([
      { headline: "央行维持利率不变", url: "https://cn.example.com/1" },
      { headline: "央行维持利率不变。", url: "https://cn2.example.com/9" },
    ]);
    expect(out).toHaveLength(1);
  });
});
