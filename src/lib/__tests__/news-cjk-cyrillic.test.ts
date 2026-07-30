import { describe, it, expect } from "vitest";
import { detectLanguage, detectScript, needsTranslation } from "../language-detect";
import {
  canonicalUrlKey,
  normalizeHeadlineKey,
  dedupeKeysFor,
  dedupeNewsItems,
  buildSeenKeySet,
  filterUnseen,
} from "../news-dedupe";

// Sample headlines (kept short and realistic).
const ZH = "央行下调存款准备金率 提振经济";
const ZH_TRAD = "央行下調存款準備金率";
const JA = "日銀、金利据え置きを決定";
const KO = "한국은행 기준금리 동결 결정";
const RU = "Центробанк сохранил ключевую ставку";
const UK = "Нацбанк знизив облікову ставку";
const SR = "Народна банка задржала каматну стопу";
const EN = "Central bank holds key rate steady";

describe("script detection — CJK and Cyrillic", () => {
  it("identifies each script", () => {
    expect(detectScript(ZH)).toBe("han");
    expect(detectScript(ZH_TRAD)).toBe("han");
    expect(detectScript(JA)).toBe("kana");
    expect(detectScript(KO)).toBe("hangul");
    expect(detectScript(RU)).toBe("cyrillic");
    expect(detectScript(UK)).toBe("cyrillic");
    expect(detectScript(SR)).toBe("cyrillic");
    expect(detectScript(EN)).toBe("latin");
  });

  it("prefers Japanese over Chinese when kana is mixed with kanji", () => {
    const d = detectLanguage("日本経済は回復しています");
    expect(d.script).toBe("kana");
    expect(d.code).toBe("ja");
  });

  it("reports kanji-only headlines as Chinese (han) rather than guessing", () => {
    const d = detectLanguage(ZH);
    expect(d.script).toBe("han");
    expect(d.code).toBe("zh");
    expect(d.name).toBe("Chinese");
  });

  it("names Korean but leaves Cyrillic language unnamed (ru/uk/sr ambiguity)", () => {
    expect(detectLanguage(KO).code).toBe("ko");
    for (const h of [RU, UK, SR]) {
      const d = detectLanguage(h);
      expect(d.script).toBe("cyrillic");
      expect(d.code).toBeNull();
      expect(d.name).toBeNull();
    }
  });

  it("marks every non-Latin headline as non-English with high confidence", () => {
    for (const h of [ZH, ZH_TRAD, JA, KO, RU, UK, SR]) {
      const d = detectLanguage(h);
      expect(d.isEnglish).toBe(false);
      expect(d.confidence).toBeGreaterThanOrEqual(0.9);
      expect(needsTranslation(h)).toBe(true);
    }
    expect(needsTranslation(EN)).toBe(false);
  });

  it("is stable across repeated calls (same verdict every refresh)", () => {
    for (const h of [ZH, JA, KO, RU]) {
      const a = detectLanguage(h);
      const b = detectLanguage(h);
      expect(a).toEqual(b);
    }
  });

  it("still detects the script when Latin tickers are embedded", () => {
    expect(detectScript("阿里巴巴 BABA 股价上涨 3%")).toBe("han");
    expect(detectScript("Газпром GAZP акции выросли на 2%")).toBe("cyrillic");
  });
});

describe("headline keys — non-Latin scripts survive normalisation", () => {
  it("never collapses CJK/Cyrillic headlines to an empty key", () => {
    for (const h of [ZH, ZH_TRAD, JA, KO, RU, UK, SR]) {
      expect(normalizeHeadlineKey(h).length).toBeGreaterThan(0);
    }
  });

  it("keeps distinct stories distinct across scripts", () => {
    const keys = [ZH, JA, KO, RU, UK, SR].map(normalizeHeadlineKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("collapses punctuation, full-width spacing and case variants", () => {
    expect(normalizeHeadlineKey("央行下调存款准备金率，提振经济"))
      .toBe(normalizeHeadlineKey("央行下调存款准备金率 提振经济"));
    expect(normalizeHeadlineKey("Центробанк сохранил ключевую ставку."))
      .toBe(normalizeHeadlineKey("ЦЕНТРОБАНК СОХРАНИЛ КЛЮЧЕВУЮ СТАВКУ"));
    expect(normalizeHeadlineKey("日銀、金利据え置きを決定"))
      .toBe(normalizeHeadlineKey("日銀 金利据え置きを決定"));
  });

  it("strips wire prefixes ahead of a non-Latin body", () => {
    expect(normalizeHeadlineKey("UPDATE 2-Центробанк сохранил ключевую ставку"))
      .toBe(normalizeHeadlineKey(RU));
  });

  it("indexes a translated row under both the English and original keys", () => {
    const keys = dedupeKeysFor({
      headline: "PBOC cuts reserve requirement ratio",
      original_headline: ZH,
      url: "https://example.cn/a?utm_source=x",
    });
    expect(keys).toContain(`h:${normalizeHeadlineKey("PBOC cuts reserve requirement ratio")}`);
    expect(keys).toContain(`h:${normalizeHeadlineKey(ZH)}`);
    expect(keys).toContain(`u:${canonicalUrlKey("https://example.cn/a")}`);
  });
});

describe("deduping across scripts and translation states", () => {
  it("collapses the source-language row against its translated twin", () => {
    const out = dedupeNewsItems([
      { headline: "PBOC cuts reserve requirement ratio", original_headline: ZH, url: null },
      { headline: ZH, url: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe("PBOC cuts reserve requirement ratio");
  });

  it("collapses in the reverse order too (original ingested first)", () => {
    const out = dedupeNewsItems([
      { headline: RU, url: null },
      { headline: "Central bank keeps key rate unchanged", original_headline: RU, url: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe(RU);
  });

  it("does not merge different stories that share a script", () => {
    const out = dedupeNewsItems([
      { headline: RU, url: "https://a.ru/1" },
      { headline: UK, url: "https://b.ua/1" },
      { headline: SR, url: "https://c.rs/1" },
      { headline: JA, url: "https://d.jp/1" },
      { headline: KO, url: "https://e.kr/1" },
    ]);
    expect(out).toHaveLength(5);
  });

  it("treats simplified and traditional Chinese as distinct rows (no false merge)", () => {
    const out = dedupeNewsItems([
      { headline: ZH, url: null },
      { headline: ZH_TRAD, url: null },
    ]);
    expect(out).toHaveLength(2);
  });

  it("stays idempotent across repeated ingestion passes", () => {
    const incoming = [
      { headline: ZH, url: "https://cn.example/1" },
      { headline: JA, url: "https://jp.example/1" },
      { headline: RU, url: "https://ru.example/1" },
    ];
    const seen = buildSeenKeySet([]);
    const first = filterUnseen(incoming, seen);
    const second = filterUnseen(incoming, seen);
    const third = filterUnseen(incoming.map((i) => ({ ...i, url: `${i.url}?utm_source=cron` })), seen);
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(0);
  });

  it("filters a later translation of an already-stored non-Latin headline", () => {
    const seen = buildSeenKeySet([{ headline: KO, url: null }]);
    const out = filterUnseen(
      [{ headline: "Bank of Korea holds base rate", original_headline: KO, url: null }],
      seen,
    );
    expect(out).toHaveLength(0);
  });
});

// Mirrors the citation lookup in src/lib/news.functions.ts: influence buckets are
// keyed on the normalised headline the AI cited, and reel rows resolve via their
// own headline first, then their original-language headline.
function matchCitation(
  buckets: Map<string, string>,
  row: { headline: string; original_headline?: string | null },
): string | undefined {
  return (
    buckets.get(normalizeHeadlineKey(row.headline)) ??
    (row.original_headline ? buckets.get(normalizeHeadlineKey(row.original_headline)) : undefined)
  );
}

describe("citation matching across scripts", () => {
  it("matches a citation logged in the source language after translation lands", () => {
    const buckets = new Map([[normalizeHeadlineKey(ZH), "decision-1"]]);
    expect(
      matchCitation(buckets, {
        headline: "PBOC cuts reserve requirement ratio",
        original_headline: ZH,
      }),
    ).toBe("decision-1");
  });

  it("matches a citation logged in English against an untranslated original", () => {
    const buckets = new Map([[normalizeHeadlineKey("Bank of Russia holds key rate"), "decision-2"]]);
    expect(
      matchCitation(buckets, {
        headline: "Bank of Russia holds key rate",
        original_headline: RU,
      }),
    ).toBe("decision-2");
  });

  it("matches Cyrillic and Hangul citations with punctuation drift", () => {
    const buckets = new Map([
      [normalizeHeadlineKey(RU), "ru"],
      [normalizeHeadlineKey(KO), "ko"],
    ]);
    expect(matchCitation(buckets, { headline: "Центробанк сохранил ключевую ставку." })).toBe("ru");
    expect(matchCitation(buckets, { headline: "한국은행, 기준금리 동결 결정" })).toBe("ko");
  });

  it("does not cross-match different non-Latin stories", () => {
    const buckets = new Map([[normalizeHeadlineKey(UK), "ua"]]);
    expect(matchCitation(buckets, { headline: RU })).toBeUndefined();
    expect(matchCitation(buckets, { headline: SR })).toBeUndefined();
  });
});
