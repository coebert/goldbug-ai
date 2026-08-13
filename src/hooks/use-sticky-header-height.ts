import { useEffect, type RefObject } from "react";

/**
 * Publishes the measured height of the app header as `--app-header-h` so every
 * sticky sub-nav (portfolio tabs, section index, leaf back rows) lines up
 * exactly beneath it, including on notched devices where the safe-area inset
 * varies.
 *
 * The header row itself has a fixed height, so this should only fire on the
 * safe-area inset settling and on device rotation. It is guarded anyway:
 *
 * - Sub-pixel noise is ignored (a fractional change would move every sticky
 *   offset below it for no visible gain).
 * - A real change during an active touch gesture is deferred until the finger
 *   lifts, so the page never shifts mid-scroll.
 * - Rotation (`orientationchange` / visual-viewport resize) force-flushes any
 *   deferred write and clears the gesture guard: iOS frequently drops the
 *   trailing `touchend` when the device rotates, which would otherwise pin the
 *   old portrait height forever and leave every sub-nav offset wrong in
 *   landscape.
 */
export function useStickyHeaderHeight(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const root = document.documentElement;
    let applied = 0;
    let pending: number | null = null;
    let touching = false;

    const write = (h: number) => {
      applied = h;
      root.style.setProperty("--app-header-h", `${h}px`);
    };
    const measure = () => Math.round(el.getBoundingClientRect().height);
    const apply = () => {
      const h = measure();
      if (!h || Math.abs(h - applied) < 1) return;
      if (touching) {
        pending = h;
        return;
      }
      write(h);
    };
    const onTouchStart = () => {
      touching = true;
    };
    const onTouchEnd = () => {
      touching = false;
      if (pending != null) {
        write(pending);
        pending = null;
      }
    };
    // Rotation: the gesture guard is meaningless across an orientation change
    // (the scroll the user was mid-way through has already been re-laid-out),
    // so drop it and re-measure. Measure twice — Safari reports the pre-rotate
    // box synchronously and settles on the next frame.
    const onRotate = () => {
      touching = false;
      pending = null;
      apply();
      requestAnimationFrame(apply);
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    const opts = { passive: true } as const;
    window.addEventListener("touchstart", onTouchStart, opts);
    window.addEventListener("touchend", onTouchEnd, opts);
    window.addEventListener("touchcancel", onTouchEnd, opts);
    window.addEventListener("orientationchange", onRotate);
    window.visualViewport?.addEventListener("resize", onRotate);
    return () => {
      ro.disconnect();
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("orientationchange", onRotate);
      window.visualViewport?.removeEventListener("resize", onRotate);
    };
  }, [ref]);
}
