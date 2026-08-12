import { useCallback, useEffect, useRef, useState } from "react";
import { useAxisLockedScroll } from "@/hooks/use-axis-locked-scroll";

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
  top = "var(--app-header-h)",
}: {
  items: readonly SectionIndexItem[];
  className?: string;
  offset?: number;
  top?: string;
}) {
  const [present, setPresent] = useState<SectionIndexItem[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // Dedicated gesture handling for the chip strip: locks each touch to one
  // axis so a diagonal flick either scrolls the chips or the page, never both.
  const { ref: rowRef, isGesturing } = useAxisLockedScroll<HTMLDivElement>();

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

  // True while a finger is down. Touch scrolling on iOS is interrupted if we
  // write to scrollLeft mid-gesture, so all scroll writes are deferred until
  // the gesture ends.
  const touchingRef = useRef(false);
  const pendingRef = useRef(false);

  // Scroll spy: the topmost section whose start is above the fold wins.
  // Reads only — measured inside rAF so it never blocks the scroll thread.
  useEffect(() => {
    if (present.length === 0) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = 120 + offset;
      let current: string | null = null;
      for (const i of present) {
        const el = document.getElementById(i.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= line) current = i.id;
      }
      setActive(current ?? present[0]!.id);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [present, offset]);

  // Centre the active chip. Never called while the user is mid-gesture.
  const centreActive = useCallback(() => {
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

  // Track the gesture with passive listeners so touch scrolling stays on the
  // compositor; flush any deferred chip centring once the finger lifts.
  useEffect(() => {
    const onStart = () => {
      touchingRef.current = true;
    };
    const onEnd = () => {
      touchingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        centreActive();
      }
    };
    const opts = { passive: true } as const;
    window.addEventListener("touchstart", onStart, opts);
    window.addEventListener("touchend", onEnd, opts);
    window.addEventListener("touchcancel", onEnd, opts);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [centreActive]);

  // Keep the active chip in view on narrow screens. Scroll the row
  // horizontally by hand — scrollIntoView() also scrolls ancestors, which
  // yanked the whole page back to the sticky row while scrolling.
  useEffect(() => {
    if (touchingRef.current || isGesturing()) {
      pendingRef.current = true;
      return;
    }
    centreActive();
  }, [active, centreActive, isGesturing]);




  if (present.length < 2) return null;

  return (
    <nav
      aria-label="Sections on this page"
      data-sticky-nav
      style={{ top }}
      className={`sticky z-20 -mx-4 mb-4 h-[var(--subnav-h,3.25rem)] border-b border-border bg-surface-1/90 px-4 backdrop-blur ${className}`}
    >
      {/* Fixed row height: chips wrapping or a longer label appearing must not
          resize the bar, or every sticky offset below it shifts mid-scroll. */}
      <div
        ref={rowRef}
        data-chip-scroller
        className="flex h-full min-w-0 touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {present.map((i) => (
          <a
            key={i.id}
            href={`#${i.id}`}
            data-section={i.id}
            aria-current={active === i.id ? "true" : undefined}
            className={`inline-flex h-11 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm transition-colors hover:bg-muted hover:text-foreground ${
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
