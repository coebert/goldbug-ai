// Fetches headline CPI (year-on-year) for the markets this account trades.
//
// Two keyless public sources, in order:
//   1. OECD SDMX (`DSD_PRICES`) — freshest monthly prints for most members.
//   2. DBnomics' mirror of the IMF CPI dataset — fills the gaps OECD does not
//      publish (Japan in particular) and acts as a fallback when OECD is down.
//
// Results are memoised for an hour through the shared market-context cache, so
// an hourly tick across several portfolios costs at most one fetch per source.

import { cached } from "./market-context-cache.server";
import type { InflationPoint, InflationSnapshot } from "./inflation";

type AreaSpec = { area: string; label: string; currency: string; oecd: string | null; imf: string };

const AREAS: AreaSpec[] = [
  { area: "GB", label: "United Kingdom", currency: "GBP", oecd: "GBR", imf: "GB" },
  { area: "US", label: "United States", currency: "USD", oecd: "USA", imf: "US" },
  { area: "EA", label: "Euro area", currency: "EUR", oecd: "EA20", imf: "U2" },
  { area: "DE", label: "Germany", currency: "EUR", oecd: "DEU", imf: "DE" },
  { area: "FR", label: "France", currency: "EUR", oecd: "FRA", imf: "FR" },
  { area: "JP", label: "Japan", currency: "JPY", oecd: "JPN", imf: "JP" },
  { area: "AU", label: "Australia", currency: "AUD", oecd: "AUS", imf: "AU" },
];

const TIMEOUT_MS = 15_000;

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

type Series = { period: string; value: number }[];

/** OECD monthly headline CPI, % change on the same month a year earlier. */
async function fetchOecd(): Promise<Map<string, Series>> {
  const codes = AREAS.map((a) => a.oecd).filter(Boolean).join("+");
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - 26);
  const startPeriod = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  const url =
    `https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/` +
    `${codes}.M.N.CPI.PA._T.N.GY?startPeriod=${startPeriod}&dimensionAtObservation=AllDimensions&format=jsondata`;
  const json = (await getJson(url)) as
    | {
        data?: {
          structure?: { dimensions?: { observation?: { id: string; values: { id: string }[] }[] } };
          dataSets?: { observations?: Record<string, (number | null)[]> }[];
        };
      }
    | null;
  const out = new Map<string, Series>();
  const dims = json?.data?.structure?.dimensions?.observation;
  const obs = json?.data?.dataSets?.[0]?.observations;
  if (!dims || !obs) return out;
  const order = dims.map((d) => d.id);
  const areaIdx = order.indexOf("REF_AREA");
  const timeIdx = order.indexOf("TIME_PERIOD");
  if (areaIdx < 0 || timeIdx < 0) return out;
  const areaVals = dims[areaIdx]!.values.map((v) => v.id);
  const timeVals = dims[timeIdx]!.values.map((v) => v.id);
  for (const [key, arr] of Object.entries(obs)) {
    const parts = key.split(":").map((n) => Number(n));
    const code = areaVals[parts[areaIdx] ?? -1];
    const period = timeVals[parts[timeIdx] ?? -1];
    const value = arr?.[0];
    if (!code || !period || typeof value !== "number" || !Number.isFinite(value)) continue;
    const list = out.get(code) ?? [];
    list.push({ period, value });
    out.set(code, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.period.localeCompare(b.period));
  return out;
}

/**
 * OECD G20 price dataflow — carries the current monthly Japanese CPI prints
 * that `DSD_PRICES` omits (Japan 404s there at every frequency).
 */
async function fetchOecdG20(): Promise<Map<string, Series>> {
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - 26);
  const startPeriod = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  const url =
    `https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_G20_PRICES@DF_G20_PRICES,1.0/` +
    `JPN.M.N.CPI.PA._T.N.GY?startPeriod=${startPeriod}&dimensionAtObservation=AllDimensions&format=jsondata`;
  const json = (await getJson(url)) as
    | {
        data?: {
          structure?: { dimensions?: { observation?: { id: string; values: { id: string }[] }[] } };
          dataSets?: { observations?: Record<string, (number | null)[]> }[];
        };
      }
    | null;
  const out = new Map<string, Series>();
  const dims = json?.data?.structure?.dimensions?.observation;
  const obs = json?.data?.dataSets?.[0]?.observations;
  if (!dims || !obs) return out;
  const order = dims.map((d) => d.id);
  const timeIdx = order.indexOf("TIME_PERIOD");
  if (timeIdx < 0) return out;
  const timeVals = dims[timeIdx]!.values.map((v) => v.id);
  const list: Series = [];
  for (const [key, arr] of Object.entries(obs)) {
    const parts = key.split(":").map((n) => Number(n));
    const period = timeVals[parts[timeIdx] ?? -1];
    const value = arr?.[0];
    if (!period || typeof value !== "number" || !Number.isFinite(value)) continue;
    list.push({ period, value });
  }
  list.sort((a, b) => a.period.localeCompare(b.period));
  if (list.length > 0) out.set("JPN", list);
  return out;
}

/** IMF CPI (via DBnomics) — fallback and gap-filler. */
async function fetchImf(): Promise<Map<string, Series>> {
  const areas = AREAS.map((a) => a.imf);
  const dimensions = encodeURIComponent(
    JSON.stringify({ REF_AREA: areas, INDICATOR: ["PCPI_PC_CP_A_PT"], FREQ: ["M"] }),
  );
  const url = `https://api.db.nomics.world/v22/series/IMF/CPI?dimensions=${dimensions}&observations=1&limit=30`;
  const json = (await getJson(url)) as
    | { series?: { docs?: { series_code?: string; period?: string[]; value?: (number | null)[] }[] } }
    | null;
  const out = new Map<string, Series>();
  for (const doc of json?.series?.docs ?? []) {
    const code = doc.series_code?.split(".")[1];
    if (!code) continue;
    const periods = doc.period ?? [];
    const values = doc.value ?? [];
    const list: Series = [];
    for (let i = 0; i < periods.length; i++) {
      const v = values[i];
      const p = periods[i];
      if (!p || typeof v !== "number" || !Number.isFinite(v)) continue;
      list.push({ period: p.slice(0, 7), value: v });
    }
    list.sort((a, b) => a.period.localeCompare(b.period));
    out.set(code, list);
  }
  return out;
}

function pointFrom(spec: AreaSpec, series: Series | undefined, source: string): InflationPoint | null {
  if (!series || series.length === 0) return null;
  const last = series[series.length - 1]!;
  const prev = series.length > 1 ? series[series.length - 2]! : null;
  return {
    area: spec.area,
    label: spec.label,
    currency: spec.currency,
    yoy: Number(last.value.toFixed(2)),
    period: last.period,
    previousYoy: prev ? Number(prev.value.toFixed(2)) : null,
    previousPeriod: prev ? prev.period : null,
    source,
  };
}

async function loadInflation(): Promise<InflationSnapshot> {
  const [oecd, g20, imf] = await Promise.all([
    fetchOecd().catch(() => new Map<string, Series>()),
    fetchOecdG20().catch(() => new Map<string, Series>()),
    fetchImf().catch(() => new Map<string, Series>()),
  ]);
  const points: InflationPoint[] = [];
  for (const spec of AREAS) {
    const candidates = [
      spec.oecd ? pointFrom(spec, oecd.get(spec.oecd), "OECD") : null,
      spec.oecd ? pointFrom(spec, g20.get(spec.oecd), "OECD G20") : null,
      pointFrom(spec, imf.get(spec.imf), "IMF"),
    ].filter((p): p is InflationPoint => p !== null);
    // Prefer whichever source has the most recent print.
    const best = candidates.sort((a, b) => b.period.localeCompare(a.period))[0];
    if (best) points.push(best);
  }
  return { fetchedAt: new Date().toISOString(), points };
}

/** Cached (1h) inflation snapshot across the key markets. */
export async function getInflationSnapshot(): Promise<InflationSnapshot | null> {
  try {
    const snap = await cached("inflation", "cpi-yoy", loadInflation);
    return snap.points.length > 0 ? snap : null;
  } catch {
    return null;
  }
}
