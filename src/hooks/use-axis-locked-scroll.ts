import { useCallback, useEffect, useRef } from "react";

/**
 * Gesture handling for a horizontally scrollable strip (chip rows, tab rails)
 * that lives inside a vertically scrolling page.
 *
 * Without this, a diagonal flick does both: the strip slides sideways *and*
 * the page scrolls, which on mobile reads as the page "jumping" while you try
 * to pick a section. The hook locks each gesture to one axis on the first few
 * pixels of movement and then keeps it there for the rest of the gesture:
 *
 *  - horizontal lock -> the strip scrolls, page scroll is suppressed
 *    (`preventDefault` on a non-passive `touchmove`, which is why this listener
 *    can't be passive; it's scoped to the strip only).
 *  - vertical lock   -> we never touch `scrollLeft`, the page scrolls natively
 *    and keeps its momentum.
 *
 * Also adds pointer drag-to-scroll for desktop (no visible scrollbar) and
 * swallows the click that ends a drag so a chip isn't activated by accident.
 */

const AXIS_LOCK_PX = 6;
const DRAG_CLICK_SUPPRESS_PX = 4;

export type AxisLock = "none" | "x" | "y";

export function useAxisLockedScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  /** True from touchstart/pointerdown until the gesture ends. */
  const gesturingRef = useRef(false);
  const axisRef = useRef<AxisLock>("none");

  /** Consumers defer their own scrollLeft writes while this is true. */
  const isGesturing = useCallback(() => gesturingRef.current, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;

    const canScrollX = () => el.scrollWidth - el.clientWidth > 1;

    // ---- touch -------------------------------------------------------------
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      gesturingRef.current = true;
      axisRef.current = "none";
      startX = t.clientX;
      startY = t.clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (axisRef.current === "none") {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (Math.max(ax, ay) < AXIS_LOCK_PX) return; // not enough travel yet
        axisRef.current = ax > ay && canScrollX() ? "x" : "y";
      }

      if (axisRef.current === "x" && e.cancelable) {
        // Own the gesture: stop the page from scrolling underneath the strip.
        e.preventDefault();
      }
    };

    const endTouch = () => {
      gesturingRef.current = false;
      axisRef.current = "none";
    };

    // ---- pointer (mouse) drag ---------------------------------------------
    let dragging = false;
    let dragMoved = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0 || !canScrollX()) return;
      dragging = true;
      dragMoved = 0;
      gesturingRef.current = true;
      startX = e.clientX;
      startScrollLeft = el.scrollLeft;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      dragMoved = Math.max(dragMoved, Math.abs(dx));
      if (dragMoved > DRAG_CLICK_SUPPRESS_PX) {
        el.setPointerCapture?.(e.pointerId);
        el.scrollLeft = startScrollLeft - dx;
      }
    };

    const endPointer = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      gesturingRef.current = false;
      el.releasePointerCapture?.(e.pointerId);
    };

    // A drag that ends on a chip must not navigate to that section.
    const onClickCapture = (e: MouseEvent) => {
      if (dragMoved > DRAG_CLICK_SUPPRESS_PX) {
        e.preventDefault();
        e.stopPropagation();
        dragMoved = 0;
      }
    };

    const passive = { passive: true } as const;
    el.addEventListener("touchstart", onTouchStart, passive);
    // Non-passive on purpose: horizontal locks call preventDefault().
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", endTouch, passive);
    el.addEventListener("touchcancel", endTouch, passive);
    el.addEventListener("pointerdown", onPointerDown, passive);
    el.addEventListener("pointermove", onPointerMove, passive);
    el.addEventListener("pointerup", endPointer, passive);
    el.addEventListener("pointercancel", endPointer, passive);
    el.addEventListener("click", onClickCapture, true);

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", endTouch);
      el.removeEventListener("touchcancel", endTouch);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endPointer);
      el.removeEventListener("pointercancel", endPointer);
      el.removeEventListener("click", onClickCapture, true);
      gesturingRef.current = false;
      axisRef.current = "none";
    };
  }, []);

  return { ref, isGesturing, axisRef };
}
