// Verifies "Translated from {Language}" badge rendering across edge cases.
// Uses react-dom/server so no jsdom is needed — we assert on the produced
// static HTML directly.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TranslationBadge } from "../translation-badge";

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
});
