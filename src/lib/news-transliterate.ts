// Transliteration-tolerant matching for news headlines.
//
// The same story reaches us both in its native script and romanised — Reuters
// files "Газпром увеличил добычу газа", an aggregator files "Gazprom uvelichil
// dobychu gaza", and different wires romanise the same Cyrillic differently
// ("Sberbank"/"Sberbank", "Zhukov"/"Jukov", "Kharkiv"/"Harkiv"). Keying only on
// the literal characters shows those as separate rows and breaks the citation
// link between the AI's briefing and the reel.
//
// Strategy: romanise Cyrillic deterministically, then fold BOTH the romanised
// text and any natively-Latin text through the same lossy scheme so competing
// romanisations converge on one key. The fold is deliberately aggressive, so it
// is only used as an ADDITIONAL key (never a replacement) and only for
// headlines long enough that a collision is implausible.

/** BGN/PCGN-flavoured Cyrillic → Latin, covering ru/uk/be/bg/sr. */
const CYRILLIC_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", ђ: "dj", е: "e", ё: "yo", є: "ye",
  ж: "zh", з: "z", и: "i", і: "i", ї: "yi", й: "y", ј: "y", к: "k", л: "l", љ: "lj",
  м: "m", н: "n", њ: "nj", о: "o", п: "p", р: "r", с: "s", т: "t", ћ: "c", у: "u",
  ў: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", џ: "dz", ш: "sh", щ: "shch", ъ: "",
  ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** True when the text contains any Cyrillic character. */
export function hasCyrillic(text: string): boolean {
  return /[\u0400-\u04FF]/.test(text);
}

/** Deterministic romanisation of Cyrillic characters; other scripts pass through. */
export function transliterateCyrillic(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) {
    out += Object.prototype.hasOwnProperty.call(CYRILLIC_MAP, ch) ? CYRILLIC_MAP[ch] : ch;
  }
  return out;
}

/**
 * Lossy phonetic fold applied to romanised Latin text so competing
 * transliteration systems converge: kh/h, ts/c, y/i/j, v/w, zh/j, doubles.
 * Order matters — digraphs are folded before single letters.
 */
export function foldRomanization(text: string): string {
  return text
    .toLowerCase()
    .replace(/shch|sch|sh/g, "s")
    .replace(/zh/g, "j")
    .replace(/kh/g, "h")
    .replace(/ch/g, "c")
    .replace(/ts/g, "c")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/x/g, "ks")
    .replace(/q/g, "k")
    .replace(/w/g, "v")
    .replace(/j/g, "i")
    .replace(/y/g, "i")
    .replace(/e/g, "i")
    // Ukrainian/Russian г romanises as both "h" and "g" (prohramu/programu),
    // and kh/h already folded above — drop both so the spellings converge.
    .replace(/[hg]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/** Minimum folded length before the key is trusted — short keys collide too easily. */
export const MIN_TRANSLIT_KEY_LENGTH = 12;

/**
 * Transliteration key for a headline: romanise → normalise → fold.
 * Returns "" when the headline is too short to key safely, or when it carries
 * no Latin/Cyrillic content at all (CJK, Arabic … are handled by the literal key).
 */
export function transliterationKey(
  headline: string | null | undefined,
  normalize: (s: string) => string,
): string {
  if (!headline) return "";
  const roman = transliterateCyrillic(headline);
  const normalized = normalize(roman);
  if (!normalized) return "";
  // Only meaningful when the result is mostly ASCII letters — a CJK headline
  // romanises to itself and must not acquire a fuzzy key.
  const ascii = normalized.replace(/[^a-z0-9 ]/g, "");
  if (ascii.replace(/\s/g, "").length < normalized.replace(/\s/g, "").length * 0.8) return "";
  const folded = foldRomanization(ascii).replace(/\s+/g, " ").trim();
  if (folded.replace(/\s/g, "").length < MIN_TRANSLIT_KEY_LENGTH) return "";
  return folded;
}
