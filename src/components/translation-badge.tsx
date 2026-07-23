// Presentational badge shown next to a headline when its text was translated
// into English from another language. Kept as a standalone component so it
// can be rendered in isolation for tests and reused everywhere the reel
// surfaces a translated item (list row, details dialog, etc.).
//
// Rendering rules (asserted by tests):
//   - Nothing renders unless BOTH original_language and original_headline
//     are present. English-only items produce no badge.
//   - The visible label is exactly "Translated from {language}".
//   - The original headline is quoted in italics next to the badge.
//   - A native `title` attribute exposes the original for hover/AT users.

import { Badge } from "@/components/ui/badge";

export type TranslationBadgeProps = {
  originalLanguage: string | null | undefined;
  originalHeadline: string | null | undefined;
  /** Extra classes on the wrapper paragraph. */
  className?: string;
};

export function TranslationBadge({
  originalLanguage,
  originalHeadline,
  className,
}: TranslationBadgeProps) {
  if (!originalLanguage || !originalHeadline) return null;
  return (
    <p
      data-testid="translation-badge"
      data-original-language={originalLanguage}
      className={
        "text-[11px] text-muted-foreground " + (className ?? "")
      }
      title={`Original ${originalLanguage} headline: ${originalHeadline}`}
    >
      <Badge
        variant="outline"
        className="mr-1.5 border-amber-500/50 bg-amber-500/10 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
      >
        Translated from {originalLanguage}
      </Badge>
      <span className="italic">“{originalHeadline}”</span>
    </p>
  );
}
