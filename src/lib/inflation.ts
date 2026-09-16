// Consumer-price inflation tracking for the markets this account trades.
//
// Inflation drives the rate path, which drives discount rates, currencies and
// which sectors work. The engine already reads what central bankers *say*
// (policy-makers module); this module supplies the hard prints they react to:
// headline CPI year-on-year for the UK, US, euro area (plus Germany/France),
// Japan and Australia.
//
// Pure and I/O-free — `inflation.server.ts` owns fetching and caching.

export type InflationPoint = {
  /** ISO country / area code used by this app: GB, US, EA, DE, FR, JP, AU. */
  area: string;
  label: string;
  /** Currency whose assets this print most directly affects. */
  currency: string;
  /** Latest headline CPI, % year-on-year. */
  yoy: number;
  /** Period of that print, e.g. "2026-08". */
  period: string;
  /** Previous month's print, when known. */
  previousYoy: number | null;
  previousPeriod: string | null;
  source: string;
};

export type InflationSnapshot = {
  fetchedAt: string;
  points: InflationPoint[];
};

/** Central-bank inflation target used to judge each print. */
export const INFLATION_TARGETS: Record<string, number> = {
  GB: 2,
  US: 2,
  EA: 2,
  DE: 2,
  FR: 2,
  JP: 2,
  AU: 2.5, // RBA targets 2–3%
};

export type InflationRead = {
  area: string;
  /** Distance from target in percentage points (positive = above target). */
  gap: number;
  direction: "rising" | "falling" | "flat" | "unknown";
  /** Plain-language stance this print argues for. */
  stance: "hot" | "above_target" | "on_target" | "below_target" | "cold";
};

export function readInflation(p: InflationPoint): InflationRead {
  const target = INFLATION_TARGETS[p.area] ?? 2;
  const gap = Number((p.yoy - target).toFixed(2));
  const delta = p.previousYoy == null ? null : p.yoy - p.previousYoy;
  const direction =
    delta == null ? "unknown" : delta > 0.1 ? "rising" : delta < -0.1 ? "falling" : "flat";
  const stance: InflationRead["stance"] =
    gap >= 1.5
      ? "hot"
      : gap >= 0.4
        ? "above_target"
        : gap <= -1
          ? "cold"
          : gap <= -0.4
            ? "below_target"
            : "on_target";
  return { area: p.area, gap, direction, stance };
}

/**
 * Bounded risk-appetite adjustment implied by an area's inflation picture.
 *
 * Hot and still rising inflation means the rate path can only get harder, so
 * size down in that currency's assets; inflation back at or under target with
 * a falling trend is a mild tailwind. Deliberately small — this is context,
 * never a trade signal on its own.
 */
export const INFLATION_MAX_NUDGE = 0.08;

export function inflationNudge(p: InflationPoint): number {
  const read = readInflation(p);
  let raw = -read.gap / 4; // +2pp above target => -0.5 before clamping
  if (read.direction === "rising") raw -= 0.03;
  if (read.direction === "falling") raw += 0.03;
  const clamped = Math.max(-INFLATION_MAX_NUDGE, Math.min(INFLATION_MAX_NUDGE, raw));
  return Number(clamped.toFixed(4));
}

/** Prompt block describing the current inflation picture across key markets. */
export function formatInflationBlock(snapshot: InflationSnapshot | null): string {
  if (!snapshot || snapshot.points.length === 0) {
    return "INFLATION (CPI year-on-year): unavailable this run — do not assume a benign rate path.";
  }
  const lines = ["INFLATION — headline CPI % year-on-year, latest official prints:"];
  for (const p of snapshot.points) {
    const read = readInflation(p);
    const prev =
      p.previousYoy == null
        ? "no prior print"
        : `prev ${p.previousYoy.toFixed(1)}% (${p.previousPeriod ?? "n/a"})`;
    lines.push(
      `- ${p.label} (${p.currency}): ${p.yoy.toFixed(1)}% for ${p.period}, ${prev} — ${read.direction}, ${read.stance.replace(/_/g, " ")} vs ${(INFLATION_TARGETS[p.area] ?? 2).toFixed(1)}% target [${p.source}]`,
    );
  }
  lines.push(
    "Use this for the rate path, not as a trade signal: inflation hot and rising in a currency argues for smaller BUYs, shorter holds and a preference for pricing-power / short-duration names in that market; inflation at or below target and falling supports normal risk-taking when the technicals agree. Prints are published with a lag — never assume today's tape already reflects a print you have not seen.",
  );
  return lines.join("\n");
}
