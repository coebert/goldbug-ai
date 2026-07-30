// Shared wrapper for Recharts <ResponsiveContainer> charts.
//
// Two layout bugs this fixes:
//  1. Chart boxes that live inside flex/grid parents inherit `min-width: auto`,
//     so they can grow with the window but never shrink back — the SVG keeps
//     its widest measured size and gets clipped by the card. `min-w-0` plus
//     `overflow-hidden` lets the box track the container in both directions.
//  2. On orientation change some browsers fire the resize after layout has
//     settled, so ResizeObserver reports a stale box. Bumping a remount key on
//     the next frame forces the container to re-measure.

import { useEffect, useState, type ReactNode } from "react";

export function ChartFrame({
  className = "",
  children,
  ...rest
}: {
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  const [remeasureKey, setRemeasureKey] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const bump = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRemeasureKey((k) => k + 1));
    };
    window.addEventListener("orientationchange", bump);
    const mq = window.matchMedia("(orientation: portrait)");
    mq.addEventListener?.("change", bump);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("orientationchange", bump);
      mq.removeEventListener?.("change", bump);
    };
  }, []);

  return (
    <div className={`w-full min-w-0 max-w-full overflow-hidden ${className}`} {...rest}>
      <div key={remeasureKey} className="h-full w-full min-w-0">
        {children}
      </div>
    </div>
  );
}
