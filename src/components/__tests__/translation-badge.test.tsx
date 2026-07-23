// Verifies "Translated from {Language}" badge rendering across edge cases.
// Uses react-dom/server so no jsdom is needed — we assert on the produced
// static HTML directly.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TranslationBadge, formatConfidencePct } from "../translation-badge";


function render(props: Parameters<typeof TranslationBadge>[0]) {
  return renderToStaticMarkup(<TranslationBadge {...props} />);
}

describe("<TranslationBadge>", () => {
  it("renders the badge with the language name and the quoted original", () => {
    const html = render({
      originalLanguage: "Russian",
      originalHeadline: "Центробанк повысил ставку",
    });
    expect(html).toContain("Translated from Russian");
    expect(html).toContain("Центробанк повысил ставку");
    // Exposes the original in the title attribute for hover / screen readers.
    expect(html).toContain('title="Original Russian headline: Центробанк повысил ставку"');
    // Stable hook for downstream tests.
    expect(html).toContain('data-testid="translation-badge"');
    expect(html).toContain('data-original-language="Russian"');
  });

  it.each([
    ["English-only item", { originalLanguage: null, originalHeadline: null }],
    ["missing language only", { originalLanguage: null, originalHeadline: "央行加息" }],
    ["missing original text only", { originalLanguage: "Mandarin Chinese", originalHeadline: null }],
    ["empty-string language", { originalLanguage: "", originalHeadline: "央行加息" }],
    ["empty-string headline", { originalLanguage: "Mandarin Chinese", originalHeadline: "" }],
    ["undefined props", { originalLanguage: undefined, originalHeadline: undefined }],
  ])("renders nothing when %s", (_label, props) => {
    expect(render(props)).toBe("");
  });

  it.each([
    ["Mandarin Chinese", "央行加息"],
    ["Greek", "Παγκόσμια αγορά"],
    ["Arabic", "ارتفاع الأسهم"],
    ["French", "La bourse en hausse"],
  ])("shows the correct label for %s", (lang, headline) => {
    const html = render({ originalLanguage: lang, originalHeadline: headline });
    expect(html).toContain(`Translated from ${lang}`);
    expect(html).toContain(headline);
  });

  it("does not double-escape unicode headlines", () => {
    const html = render({
      originalLanguage: "Japanese",
      originalHeadline: "日経平均、最高値更新",
    });
    // The original characters must round-trip verbatim into the output.
    expect(html).toContain("日経平均、最高値更新");
  });

  it("honours the className extension without dropping base classes", () => {
    const html = render({
      originalLanguage: "Spanish",
      originalHeadline: "Bolsa sube",
      className: "mt-2 custom-x",
    });
    expect(html).toMatch(/class="[^"]*text-\[11px\][^"]*mt-2 custom-x/);
  });

  describe("confidence chip", () => {
    it("shows a rounded percentage chip and enriches the title when confidence is provided", () => {
      const html = render({
        originalLanguage: "German",
        originalHeadline: "Börse steigt",
        confidence: 0.923,
      });
      expect(html).toContain("92% confidence");
      expect(html).toContain('data-testid="translation-confidence"');
      expect(html).toContain('data-translation-confidence="92%"');
      expect(html).toContain("translation confidence 92%");
    });

    it("clamps out-of-range confidences into [0,1] before rendering", () => {
      const high = render({ originalLanguage: "Italian", originalHeadline: "Borsa sale", confidence: 1.7 });
      expect(high).toContain("100% confidence");
      const low = render({ originalLanguage: "Italian", originalHeadline: "Borsa sale", confidence: -0.4 });
      expect(low).toContain("0% confidence");
    });

    it("omits the confidence chip when the value is missing or non-finite", () => {
      for (const c of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        const html = render({
          originalLanguage: "French",
          originalHeadline: "La bourse en hausse",
          confidence: c as number | null | undefined,
        });
        expect(html).not.toContain("% confidence");
        expect(html).not.toContain('data-testid="translation-confidence"');

      }
    });

    it("falls back to the plain title when confidence is absent", () => {
      const html = render({ originalLanguage: "Spanish", originalHeadline: "Bolsa sube" });
      expect(html).toContain('title="Original Spanish headline: Bolsa sube"');
    });
  });

  describe("formatConfidencePct", () => {
    it("rounds and clamps", () => {
      expect(formatConfidencePct(0.5)).toBe("50%");
      expect(formatConfidencePct(0.876)).toBe("88%");
      expect(formatConfidencePct(2)).toBe("100%");
      expect(formatConfidencePct(-1)).toBe("0%");
    });
    it("returns null for non-finite / missing values", () => {
      expect(formatConfidencePct(null)).toBeNull();
      expect(formatConfidencePct(undefined)).toBeNull();
      expect(formatConfidencePct(Number.NaN)).toBeNull();
      expect(formatConfidencePct(Number.POSITIVE_INFINITY)).toBeNull();
    });
  });
});

