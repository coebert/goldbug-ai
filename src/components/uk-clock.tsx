import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { formatUkTime, ukHour, ukZoneAbbr } from "@/lib/uk-time";

/**
 * Persistent UK-time clock with a live countdown to the next hourly
 * scheduled AI run. Lives in the header so users always know what
 * timezone the app is quoting and when the next automated cycle fires.
 *
 * Renders compactly on mobile (time only) and expands to
 * "HH:MM:SS BST · next run in mm:ss" on ≥ md.
 */
export function UkClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const zone = ukZoneAbbr(now);
  const timeStr = formatUkTime(now);

  // Countdown to the top of the next UK hour.
  const nowMs = now.getTime();
  const hourStart = new Date(now);
  hourStart.setMinutes(0, 0, 0);
  const nextRun = new Date(hourStart.getTime() + 60 * 60 * 1000);
  const remainingMs = Math.max(0, nextRun.getTime() - nowMs);
  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);
  const nextHour = (ukHour(now) + 1) % 24;
  const countdown = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

  return (
    <div
      className="hidden items-center gap-2 rounded-md border border-border/60 bg-surface-sunken px-2.5 py-1 text-xs text-muted-foreground md:inline-flex num"
      title={`Local UK time. Next automated run at ${String(nextHour).padStart(2, "0")}:00 ${zone} (in ${countdown}).`}
      aria-label={`UK time ${timeStr} ${zone}. Next run in ${countdown}.`}
    >
      <Clock className="h-3.5 w-3.5 shrink-0 text-primary/80" aria-hidden />
      <span className="font-medium text-foreground/90">{timeStr}</span>
      <span className="text-muted-foreground/70">{zone}</span>
      <span className="hidden text-muted-foreground/50 lg:inline">·</span>
      <span className="hidden lg:inline">next run {countdown}</span>
    </div>
  );
}
