// Deterministic, dependency-free language detection for news headlines.
//
// Two problems this solves:
//   1. Translation routing. The old gate was `/[^\x00-\x7F]/` — any non-ASCII
//      char. That misses every Latin-script non-English headline written
//      without diacritics ("Banco central sobe juros", "Regierung plant neue
//      Steuer"), so those headlines were cached and displayed raw.
//   2. Display/dedupe consistency. Once we know the script and the likely
//      language up front, the reel can label an item the same way on every
//      refresh instead of depending on whether the LLM happened to answer.
//
// The detector is intentionally conservative: it reports English unless it
// finds positive evidence of another language. Non-English verdicts route the
// headline to the LLM, which remains the authority on the final language name
// and translation — this only decides *whether to ask*.

export type DetectedScript =
  | "latin"
  | "cyrillic"
  | "greek"
  | "arabic"
  | "hebrew"
  | "devanagari"
  | "han"
  | "kana"
  | "hangul"
  | "thai"
  | "other";

export type LanguageDetection = {
  /** ISO-639-1 code when we can name it, else null (script known but language not). */
  code: string | null;
  /** Full English display name, e.g. "Spanish". Null when only the script is known. */
  name: string | null;
  script: DetectedScript;
  /** 0..1 heuristic confidence in `isEnglish` (not in the specific language). */
  confidence: number;
  isEnglish: boolean;
};

const SCRIPT_RANGES: Array<{ script: DetectedScript; re: RegExp; name: string | null; code: string | null }> = [
  // Kana first: Japanese headlines mix kana with kanji, so a han-first test
  // would misreport them as Chinese.
  { script: "kana", re: /[\u3040-\u30FF]/, name: "Japanese", code: "ja" },
  { script: "han", re: /[\u4E00-\u9FFF\u3400-\u4DBF]/, name: "Chinese", code: "zh" },
  { script: "hangul", re: /[\uAC00-\uD7AF\u1100-\u11FF]/, name: "Korean", code: "ko" },
  { script: "cyrillic", re: /[\u0400-\u04FF]/, name: null, code: null },
  { script: "greek", re: /[\u0370-\u03FF]/, name: "Greek", code: "el" },
  { script: "arabic", re: /[\u0600-\u06FF\u0750-\u077F]/, name: "Arabic", code: "ar" },
  { script: "hebrew", re: /[\u0590-\u05FF]/, name: "Hebrew", code: "he" },
  { script: "devanagari", re: /[\u0900-\u097F]/, name: "Hindi", code: "hi" },
  { script: "thai", re: /[\u0E00-\u0E7F]/, name: "Thai", code: "th" },
];

// High-signal function words. Deliberately short lists of words that are both
// very common in the language and rare/absent in English headlines.
const LATIN_MARKERS: Array<{ code: string; name: string; words: string[] }> = [
  { code: "es", name: "Spanish", words: ["el", "la", "los", "las", "del", "una", "para", "por", "con", "que", "sobre", "más", "según", "gobierno", "años", "millones", "tras", "también", "empresa"] },
  { code: "pt", name: "Portuguese", words: ["do", "da", "dos", "das", "uma", "para", "com", "que", "não", "mais", "após", "governo", "empresa", "milhões", "sobre", "ações", "banco central"] },
  { code: "fr", name: "French", words: ["le", "la", "les", "des", "une", "pour", "avec", "que", "sur", "plus", "après", "gouvernement", "entreprise", "millions", "selon", "contre", "aux"] },
  { code: "de", name: "German", words: ["der", "die", "das", "den", "und", "für", "mit", "nicht", "auf", "über", "von", "bei", "regierung", "unternehmen", "milliarden", "gegen", "wird", "nach"] },
  { code: "it", name: "Italian", words: ["il", "lo", "gli", "una", "per", "con", "che", "non", "più", "dopo", "governo", "azienda", "miliardi", "sulla", "nel", "dei"] },
  { code: "nl", name: "Dutch", words: ["de", "het", "een", "van", "voor", "met", "niet", "naar", "bedrijf", "regering", "miljard", "over", "wordt", "bij"] },
  { code: "tr", name: "Turkish", words: ["ve", "için", "ile", "bir", "olarak", "sonra", "hükümet", "şirket", "milyar", "yüzde", "karşı"] },
  { code: "id", name: "Indonesian", words: ["dan", "yang", "untuk", "dengan", "dari", "pada", "akan", "pemerintah", "perusahaan", "miliar", "tidak"] },
  { code: "pl", name: "Polish", words: ["nie", "się", "dla", "przez", "oraz", "rząd", "firma", "miliardów", "wzrost", "wobec", "jest"] },
  { code: "sv", name: "Swedish", words: ["och", "för", "med", "inte", "till", "från", "regeringen", "företag", "miljarder", "efter"] },
  { code: "vi", name: "Vietnamese", words: ["của", "và", "cho", "với", "không", "được", "chính phủ", "công ty", "tỷ"] },
];

// English function words — used as counter-evidence so a headline that merely
// contains a foreign proper noun ("Banco do Brasil posts record profit")
// stays English.
const ENGLISH_MARKERS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "from", "as", "at", "by",
  "is", "are", "was", "were", "be", "been", "has", "have", "had", "will", "says", "said", "after",
  "before", "over", "under", "amid", "into", "out", "up", "down", "not", "new", "more", "than",
  "its", "their", "his", "her", "this", "that", "these", "those", "but", "how", "why", "what",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Best-effort script identification for the dominant characters in `text`. */
export function detectScript(text: string): DetectedScript {
  for (const r of SCRIPT_RANGES) if (r.re.test(text)) return r.script;
  if (/\p{Script=Latin}/u.test(text)) return "latin";
  if (/[^\x00-\x7F]/.test(text)) return "other";
  return "latin";
}

/**
 * Detect the language of a headline. Never throws; empty input reports
 * English with zero confidence so callers do not translate noise.
 */
export function detectLanguage(text: string | null | undefined): LanguageDetection {
  const raw = (text ?? "").trim();
  if (!raw) {
    return { code: "en", name: "English", script: "latin", confidence: 0, isEnglish: true };
  }

  const script = detectScript(raw);
  if (script !== "latin") {
    const hit = SCRIPT_RANGES.find((r) => r.script === script);
    return {
      code: hit?.code ?? null,
      name: hit?.name ?? null,
      script,
      confidence: 0.95,
      isEnglish: false,
    };
  }

  const tokens = tokenize(raw);
  if (tokens.length === 0) {
    return { code: "en", name: "English", script, confidence: 0, isEnglish: true };
  }

  const englishHits = tokens.filter((t) => ENGLISH_MARKERS.has(t)).length;

  let best: { code: string; name: string; hits: number } | null = null;
  for (const lang of LATIN_MARKERS) {
    let hits = 0;
    for (const w of lang.words) {
      if (w.includes(" ")) {
        if (raw.toLowerCase().includes(w)) hits += 1;
      } else if (tokens.includes(w)) {
        hits += 1;
      }
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { code: lang.code, name: lang.name, hits };
  }

  // Latin letters carrying diacritics that English never uses are strong
  // evidence on their own (ñ, ü, ç, å, ø, ł, ș …), even with no marker word.
  const diacritics = (raw.match(/[\u00C0-\u024F\u1E00-\u1EFF]/g) ?? []).length;

  if (!best && diacritics === 0) {
    return { code: "en", name: "English", script, confidence: 0.8, isEnglish: true };
  }

  const foreignHits = best?.hits ?? 0;
  // Counter-evidence: a single ambiguous marker word ("a", "do", "de") is not
  // enough on its own — English headlines routinely contain foreign proper
  // nouns ("Banco do Brasil posts a record profit").
  if (diacritics === 0 && foreignHits < 2) {
    return { code: "en", name: "English", script, confidence: englishHits >= 2 ? 0.75 : 0.6, isEnglish: true };
  }
  if (foreignHits === 0 && diacritics > 0 && englishHits >= 2) {
    // Accented proper noun inside an otherwise English headline.
    return { code: "en", name: "English", script, confidence: 0.6, isEnglish: true };
  }

  const evidence = foreignHits + Math.min(2, diacritics);
  return {
    code: best?.code ?? null,
    name: best?.name ?? null,
    script,
    confidence: Math.min(0.95, 0.5 + evidence * 0.12),
    isEnglish: false,
  };
}

/** True when the headline should be sent for LLM language-detection + translation. */
export function needsTranslation(text: string | null | undefined): boolean {
  return !detectLanguage(text).isEnglish;
}
