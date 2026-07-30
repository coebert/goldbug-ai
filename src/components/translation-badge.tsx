// Presentational badge shown next to a headline when its text was translated
// into English from another language. Kept as a standalone component so it
// can be rendered in isolation for tests and reused everywhere the reel
// surfaces a translated item (list row, details dialog, etc.).
//
// Rendering rules (asserted by tests):
//   - Nothing renders unless BOTH original_language and original_headline
//     are present. English-only items produce no badge.
//   - The visible label is exactly "Translated from {language}".
//   - When a translation confidence (0..1) is provided, it is surfaced as a
//     percentage on a small trailing chip and repeated in the title tooltip.
//   - The original headline is quoted in italics next to the badge.
//   - A native `title` attribute exposes the original for hover/AT users.

import { Badge } from "@/components/ui/badge";
import { detectLanguage } from "@/lib/language-detect";

export type TranslationBadgeProps = {
  originalLanguage: string | null | undefined;
  originalHeadline: string | null | undefined;
  /** Model's self-reported confidence in the detected language + translation, 0..1. */
  confidence?: number | null;
  /**
   * The headline as displayed. Used only as an audit fallback: when the item
   * has no stored translation we still surface the client-side detected
   * language so non-English rows are never silently unlabelled.
   */
  headline?: string | null;
  /** Extra classes on the wrapper paragraph. */
  className?: string;
};

// Clamp + round a 0..1 confidence into a whole-percent string. Returns null
// when the input isn't a usable finite number (so the chip is hidden).
export function formatConfidencePct(confidence: number | null | undefined): string | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}

function confidenceTone(confidence: number | null | undefined): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return "border-border bg-muted text-muted-foreground";
  }
  const c = Math.max(0, Math.min(1, confidence));
  if (c >= 0.85) return "border-primary/50 bg-primary/10 text-primary";
  if (c >= 0.6) return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return "border-destructive/40 bg-destructive/10 text-destructive";
}

// Untranslated non-English row: label the detected language/script and the
// heuristic confidence so the result can still be audited.
function DetectedOnlyBadge({ headline, className }: { headline: string; className?: string }) {
  const det = detectLanguage(headline);
  if (det.isEnglish) return null;
  const label = det.name ?? `${det.script} script`;
  const pct = formatConfidencePct(det.confidence);
  return (
    <p
      data-testid="detected-language-badge"
      data-original-language={label}
      data-detection-confidence={pct ?? ""}
      className={"text-[11px] text-muted-foreground " + (className ?? "")}
      title={`Detected language: ${label} (heuristic confidence ${pct}). No stored translation for this headline.`}
    >
      <Badge
        variant="outline"
        className="mr-1.5 border-border bg-muted text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Detected {label}
      </Badge>
      {pct && (
        <Badge
          variant="outline"
          data-testid="detection-confidence"
          className={`mr-1.5 text-[10px] font-semibold uppercase tracking-wide ${confidenceTone(det.confidence)}`}
        >
          {pct} detection
        </Badge>
      )}
      <span className="italic">not translated</span>
    </p>
  );
}

export function TranslationBadge({
  originalLanguage,
  originalHeadline,
  confidence,
  headline,
  className,
}: TranslationBadgeProps) {
  if (!originalLanguage || !originalHeadline) {
    return headline ? <DetectedOnlyBadge headline={headline} className={className} /> : null;
  }
  const pct = formatConfidencePct(confidence);
  const title = pct
    ? `Detected language: ${originalLanguage} · translation confidence ${pct}. Original: ${originalHeadline}`
    : `Original ${originalLanguage} headline: ${originalHeadline}`;

  return (
    <p
      data-testid="translation-badge"
      data-original-language={originalLanguage}
      data-translation-confidence={pct ?? ""}
      className={
        "text-[11px] text-muted-foreground " + (className ?? "")
      }
      title={title}
    >
      <Badge
        variant="outline"
        className="mr-1.5 border-amber-500/50 bg-amber-500/10 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
      >
        Translated from {originalLanguage}
      </Badge>
      {pct && (
        <Badge
          variant="outline"
          data-testid="translation-confidence"
          className={`mr-1.5 text-[10px] font-semibold uppercase tracking-wide ${confidenceTone(confidence)}`}
          title={`Model self-reported confidence in detected language + translation: ${pct}`}
        >
          {pct} confidence
        </Badge>
      )}
      <span className="italic">“{originalHeadline}”</span>
    </p>
  );
}
