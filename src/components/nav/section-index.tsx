import { useEffect, useRef, useState } from "react";

/**
 * Sticky in-page section index for long pages (Home, Portfolio detail).
 *
 * A horizontally scrollable chip row that scroll-spies the current section
 * and jumps to it on tap. Sections are addressed by DOM id, so a chip whose
 * target isn't rendered (density level, empty state) is dropped rather than
 * scrolling nowhere.
 */
export type SectionIndexItem = { id: string; label: string };

export function SectionIndex({
  items,
  className = "",
  /** Extra offset below the sticky app header, in px. */
  offset = 0,
  /** CSS `top` for the sticky row; defaults to sitting under the app header. */
  top = "var(--app-header-h, 3.25rem)",
}: {
  items: readonly SectionIndexItem[];
  className?: string;
  offset?: number;
  top?: string;
}) {
  const [present, setPresent] = useState<SectionIndexItem[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Which targets actually exist right now. Only update state when the set
  // actually changes, so unrelated DOM churn can't re-render the row endlessly.
  useEffect(() => {
    const resolve = () =>
      setPresent((prev) => {
        const next = items.filter((i) => document.getElementById(i.id) !== null);
        const same =
          prev.length === next.length && prev.every((p, idx) => p.id === next[idx]!.id);
        return same ? prev : next;
      });
    resolve();
    const mo = new MutationObserver(resolve);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [items]);


  // Scroll spy: the topmost section whose start is above the fold wins.
  useEffect(() => {
    if (present.length === 0) return;
    const onScroll = () => {
      const line = 120 + offset;
      let current: string | null = null;
      for (const i of present) {
        const el = document.getElementById(i.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= line) current = i.id;
      }
      setActive(current ?? present[0]!.id);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [present, offset]);

  // Keep the active chip in view on narrow screens. Scroll the row
  // horizontally by hand — scrollIntoView() also scrolls ancestors, which
  // yanked the whole page back to the sticky row while scrolling.
  useEffect(() => {
    const row = rowRef.current;
    if (!active || !row) return;
    const chip = row.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!chip) return;
    const left = chip.offsetLeft;
    const right = left + chip.offsetWidth;
    if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left - 12);
    else if (right > row.scrollLeft + row.clientWidth)
      row.scrollLeft = right - row.clientWidth + 12;
  }, [active]);


  if (present.length < 2) return null;

  return (
    <nav
      aria-label="Sections on this page"
      style={{ top }}
      className={`sticky z-20 -mx-4 mb-4 border-b border-border bg-surface-1/90 px-4 backdrop-blur ${className}`}
    >
      <div
        ref={rowRef}
        className="flex min-w-0 gap-1 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {present.map((i) => (
          <a
            key={i.id}
            href={`#${i.id}`}
            data-section={i.id}
            aria-current={active === i.id ? "true" : undefined}
            className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm transition-colors hover:bg-muted hover:text-foreground ${
              active === i.id ? "bg-primary/10 text-primary" : "text-muted-foreground"
            }`}
          >
            {i.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
