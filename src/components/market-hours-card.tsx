import { useEffect, useState } from "react";
import { ChevronDown, Globe2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/home/section-header";
import { ukZoneAbbr } from "@/lib/uk-time";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Home-screen card that lists every venue the AI can trade on, with
 * open/close hours converted into the user's UK local time (BST/GMT auto).
 *
 * Times are computed live so the "Open now" pill and the countdown to the
 * next open flip automatically as sessions roll around the globe.
 */

type Market = {
  id: string;
  label: string;
  region: string;
  tz: string;
  // Local session in the venue's own timezone, minutes-since-midnight.
  openMin: number;
  closeMin: number;
  // 1 = Mon … 7 = Sun (ISO). Defaults to Mon-Fri.
  days?: number[];
  note?: string;
};

const MON_FRI = [1, 2, 3, 4, 5];

const MARKETS: Market[] = [
  { id: "lse", label: "London Stock Exchange", region: "UK", tz: "Europe/London", openMin: 8 * 60, closeMin: 16 * 60 + 30, days: MON_FRI },
  { id: "xetra", label: "Xetra / Frankfurt", region: "Germany", tz: "Europe/Berlin", openMin: 9 * 60, closeMin: 17 * 60 + 30, days: MON_FRI },
  { id: "euronext", label: "Euronext (Paris/Amsterdam)", region: "EU", tz: "Europe/Paris", openMin: 9 * 60, closeMin: 17 * 60 + 30, days: MON_FRI },
  { id: "six", label: "SIX Swiss Exchange", region: "Switzerland", tz: "Europe/Zurich", openMin: 9 * 60, closeMin: 17 * 60 + 30, days: MON_FRI },
  { id: "nyse", label: "NYSE", region: "US", tz: "America/New_York", openMin: 9 * 60 + 30, closeMin: 16 * 60, days: MON_FRI },
  { id: "nasdaq", label: "Nasdaq", region: "US", tz: "America/New_York", openMin: 9 * 60 + 30, closeMin: 16 * 60, days: MON_FRI },
  { id: "tsx", label: "Toronto Stock Exchange", region: "Canada", tz: "America/Toronto", openMin: 9 * 60 + 30, closeMin: 16 * 60, days: MON_FRI },
  { id: "tse", label: "Tokyo Stock Exchange", region: "Japan", tz: "Asia/Tokyo", openMin: 9 * 60, closeMin: 15 * 60, days: MON_FRI, note: "Lunch break 11:30–12:30 JST" },
  { id: "hkex", label: "Hong Kong (HKEX)", region: "Hong Kong", tz: "Asia/Hong_Kong", openMin: 9 * 60 + 30, closeMin: 16 * 60, days: MON_FRI },
  { id: "asx", label: "ASX", region: "Australia", tz: "Australia/Sydney", openMin: 10 * 60, closeMin: 16 * 60, days: MON_FRI },
  { id: "fx", label: "Global FX (Spot)", region: "Global", tz: "Europe/London", openMin: 0, closeMin: 24 * 60, days: [1, 2, 3, 4, 5], note: "Open Sun 22:00 → Fri 22:00 UK" },
  { id: "commodities", label: "Commodities (CME futures)", region: "Global", tz: "America/Chicago", openMin: 17 * 60, closeMin: 16 * 60, days: [1, 2, 3, 4, 5], note: "Sun 23:00 → Fri 22:00 UK, 60m daily break" },
  { id: "crypto", label: "Crypto", region: "Global", tz: "UTC", openMin: 0, closeMin: 24 * 60, days: [1, 2, 3, 4, 5, 6, 7], note: "24 / 7" },
];

/** Format minutes-since-midnight in a specific timezone into UK-local HH:MM. */
function formatVenueMinInUk(now: Date, tz: string, minute: number): string {
  // Anchor: interpret `minute` as today's clock time in `tz`, then render in UK.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const hh = String(Math.floor(minute / 60) % 24).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  // Build ISO-ish string then parse using tz offset via Intl detour.
  const anchor = new Date(`${today}T${hh}:${mm}:00`);
  const asTz = new Date(anchor.toLocaleString("en-US", { timeZone: tz }));
  const asUtc = new Date(anchor.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = asUtc.getTime() - asTz.getTime();
  const instant = new Date(anchor.getTime() + offsetMs);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
}

function venueLocalNow(now: Date, tz: string): { minute: number; isoDay: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const wk = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { minute: hh * 60 + mm, isoDay: map[wk] ?? 1 };
}

/** Convert a wall-clock time in `tz` to a UTC Date instant. */
function zonedInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"));
  const offset = asLocal - guess.getTime();
  return new Date(guess.getTime() - offset);
}

/** Date parts (y/m/d + ISO weekday) for `now` projected into `tz`. */
function venueDateParts(now: Date, tz: string): { y: number; m: number; d: number; isoDay: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    isoDay: map[get("weekday")] ?? 1,
  };
}

/** Next occurrence of `minuteOfDay` in `tz` on any of `days` that is strictly after `now`. */
function nextOccurrence(now: Date, tz: string, minuteOfDay: number, days: readonly number[]): Date | null {
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  for (let add = 0; add < 10; add++) {
    const anchor = new Date(now.getTime() + add * 86_400_000);
    const p = venueDateParts(anchor, tz);
    if (!days.includes(p.isoDay)) continue;
    const inst = zonedInstant(p.y, p.m, p.d, hh, mm, tz);
    if (inst.getTime() > now.getTime()) return inst;
  }
  return null;
}

/** Compact "1d 2h", "3h 14m", "42m", "31s" duration formatter. */
function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function marketStatus(now: Date, m: Market): { open: boolean; label: string } {
  if (m.id === "crypto") return { open: true, label: "Open 24/7" };
  const { minute, isoDay } = venueLocalNow(now, m.tz);
  const days = m.days ?? MON_FRI;
  const isTradingDay = days.includes(isoDay);
  if (m.id === "fx") {
    // Open Sun 22:00 UK → Fri 22:00 UK.
    const uk = venueLocalNow(now, "Europe/London");
    const openNow = (uk.isoDay >= 1 && uk.isoDay <= 4)
      || (uk.isoDay === 5 && uk.minute < 22 * 60)
      || (uk.isoDay === 7 && uk.minute >= 22 * 60);
    return { open: openNow, label: openNow ? "Open" : "Closed" };
  }
  if (!isTradingDay) return { open: false, label: "Closed (weekend)" };
  if (minute >= m.openMin && minute < m.closeMin) return { open: true, label: "Open" };
  return { open: false, label: minute < m.openMin ? "Pre-market" : "Closed" };
}

/** Returns the timing hint shown under each market row. Null = no countdown. */
function marketCountdown(now: Date, m: Market, open: boolean): { label: string; value: string } | null {
  if (m.id === "crypto") return null;
  if (m.id === "fx") {
    // FX: closes Fri 22:00 UK, opens Sun 22:00 UK.
    const target = open
      ? nextOccurrence(now, "Europe/London", 22 * 60, [5])
      : nextOccurrence(now, "Europe/London", 22 * 60, [7]);
    if (!target) return null;
    return { label: open ? "Closes in" : "Opens in", value: fmtCountdown(target.getTime() - now.getTime()) };
  }
  const days = m.days ?? MON_FRI;
  if (open) {
    // Session close is today by definition (we're inside it).
    const p = venueDateParts(now, m.tz);
    const closeInst = zonedInstant(p.y, p.m, p.d, Math.floor(m.closeMin / 60), m.closeMin % 60, m.tz);
    return { label: "Closes in", value: fmtCountdown(closeInst.getTime() - now.getTime()) };
  }
  const openInst = nextOccurrence(now, m.tz, m.openMin, days);
  if (!openInst) return null;
  return { label: "Opens in", value: fmtCountdown(openInst.getTime() - now.getTime()) };
}

export function MarketHoursCard() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  const zone = ukZoneAbbr(now);

  return (
    <section className="mb-6" aria-labelledby="section-market-hours">
      <SectionHeader
        as="h2"
        icon={Globe2}
        title={<span id="section-market-hours">Market hours (UK time)</span>}
        description={`Opening times of every venue the AI trades on, shown in your local UK time (${zone}).`}
      />
      <Card>
        <CardContent className="p-3 sm:p-4">
          <ul
            role="list"
            aria-label="Global market opening hours in UK time"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
          >
            {MARKETS.map((m) => {
              const status = marketStatus(now, m);
              const is247 = m.id === "crypto";
              const isFx = m.id === "fx";
              const openUk = is247 || isFx ? null : formatVenueMinInUk(now, m.tz, m.openMin);
              const closeUk = is247 || isFx ? null : formatVenueMinInUk(now, m.tz, m.closeMin);
              const countdown = marketCountdown(now, m, status.open);
              return (
                <li
                  key={m.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-border/60 bg-surface-sunken/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{m.label}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        {m.region}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground num">
                      {is247 || isFx ? (
                        <span>{m.note}</span>
                      ) : (
                        <>
                          <span className="text-foreground/80">{openUk}</span>
                          <span className="mx-1 text-muted-foreground/60">→</span>
                          <span className="text-foreground/80">{closeUk}</span>
                          <span className="ml-1 text-muted-foreground/60">{zone}</span>
                          {m.note && <div className="text-[11px] text-muted-foreground/70">{m.note}</div>}
                        </>
                      )}
                      {countdown && (
                        <div className="mt-0.5 text-[11px] text-foreground/70 num">
                          <span className="text-muted-foreground/70">{countdown.label} </span>
                          <span className="font-medium tabular-nums">{countdown.value}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <Badge
                    variant={status.open ? "default" : "secondary"}
                    className={`shrink-0 ${status.open ? "" : "opacity-70"}`}
                  >
                    {status.label}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
