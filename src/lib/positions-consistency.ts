// Positions consistency check — engine output vs what the app renders.
//
// The engine's authoritative position set (the `holdings` rows it writes after
// each run / broker reconcile) and the rows the holdings card actually paints
// can silently diverge: a row can be dropped by a filter (this is exactly how
// the short GBPUSD funding leg went invisible), or the per-row values can stop
// summing to the Invested tile after a rounding/allocation change.
//
// This module is pure so both the UI and tests can assert the same invariants:
//   1. every engine position is rendered exactly once (count + symbol parity),
//   2. quantities match per symbol,
//   3. the rendered row values sum to the invested total within tolerance.
//
// FX funding legs are counted separately: they are rendered in their own
// section and deliberately excluded from the invested allocation.

export type EnginePosition = {
  symbol: string;
  quantity: number;
  /** True for FX spot funding legs (asset_class = "fx"). */
  isFxLeg?: boolean;
};

export type RenderedPosition = {
  symbol: string;
  quantity: number;
  /** Base-currency value the UI shows for this row. */
  value: number;
};

export type PositionsConsistencyReport = {
  ok: boolean;
  engineCount: number;
  renderedCount: number;
  fxLegCount: number;
  /** Engine positions with no rendered row. */
  missingInUi: string[];
  /** Rendered rows with no engine position. */
  extraInUi: string[];
  /** Same symbol, different quantity. */
  quantityMismatches: Array<{ symbol: string; engine: number; rendered: number }>;
  /** Symbols rendered more than once. */
  duplicateRows: string[];
  renderedTotal: number;
  investedTotal: number;
  /** renderedTotal − investedTotal. */
  totalsDelta: number;
  tolerance: number;
  summary: string;
};

const norm = (s: string) => String(s ?? "").trim().toUpperCase();

export function checkPositionsConsistency(args: {
  enginePositions: EnginePosition[];
  renderedPositions: RenderedPosition[];
  /** The Invested tile value the rows are supposed to add up to. */
  investedTotal: number;
  /** Absolute money tolerance for the totals check. Default 0.01. */
  tolerance?: number;
  /** Relative quantity tolerance (fractional shares/crypto). Default 1e-6. */
  quantityTolerance?: number;
}): PositionsConsistencyReport {
  const tolerance = args.tolerance ?? 0.01;
  const qtyTol = args.quantityTolerance ?? 1e-6;

  const fxLegs = args.enginePositions.filter((p) => p.isFxLeg === true);
  const enginePositions = args.enginePositions.filter((p) => p.isFxLeg !== true);

  const engineBySymbol = new Map<string, number>();
  for (const p of enginePositions) {
    const k = norm(p.symbol);
    engineBySymbol.set(k, (engineBySymbol.get(k) ?? 0) + Number(p.quantity ?? 0));
  }

  const renderedBySymbol = new Map<string, number>();
  const renderedSeen = new Map<string, number>();
  let renderedTotal = 0;
  for (const r of args.renderedPositions) {
    const k = norm(r.symbol);
    renderedSeen.set(k, (renderedSeen.get(k) ?? 0) + 1);
    renderedBySymbol.set(k, (renderedBySymbol.get(k) ?? 0) + Number(r.quantity ?? 0));
    const v = Number(r.value);
    if (Number.isFinite(v)) renderedTotal += v;
  }

  const missingInUi = [...engineBySymbol.keys()].filter((k) => !renderedBySymbol.has(k)).sort();
  const extraInUi = [...renderedBySymbol.keys()].filter((k) => !engineBySymbol.has(k)).sort();
  const duplicateRows = [...renderedSeen.entries()]
    .filter(([, n]) => n > 1)
    .map(([k]) => k)
    .sort();

  const quantityMismatches: PositionsConsistencyReport["quantityMismatches"] = [];
  for (const [k, engineQty] of engineBySymbol) {
    if (!renderedBySymbol.has(k)) continue;
    const renderedQty = renderedBySymbol.get(k)!;
    const scale = Math.max(1, Math.abs(engineQty));
    if (Math.abs(engineQty - renderedQty) > qtyTol * scale) {
      quantityMismatches.push({ symbol: k, engine: engineQty, rendered: renderedQty });
    }
  }
  quantityMismatches.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const investedTotal = Number.isFinite(args.investedTotal) ? Number(args.investedTotal) : 0;
  const totalsDelta = round2(renderedTotal - investedTotal);
  const totalsOk = Math.abs(totalsDelta) <= tolerance;

  const ok =
    missingInUi.length === 0 &&
    extraInUi.length === 0 &&
    duplicateRows.length === 0 &&
    quantityMismatches.length === 0 &&
    totalsOk;

  const problems: string[] = [];
  if (missingInUi.length) problems.push(`${missingInUi.length} position(s) not shown (${missingInUi.slice(0, 4).join(", ")})`);
  if (extraInUi.length) problems.push(`${extraInUi.length} shown but not held (${extraInUi.slice(0, 4).join(", ")})`);
  if (duplicateRows.length) problems.push(`${duplicateRows.length} duplicated row(s)`);
  if (quantityMismatches.length) problems.push(`${quantityMismatches.length} quantity mismatch(es)`);
  if (!totalsOk) problems.push(`rows sum off by ${totalsDelta.toFixed(2)}`);

  const fxNote = fxLegs.length
    ? ` · ${fxLegs.length} FX funding leg${fxLegs.length === 1 ? "" : "s"} shown separately`
    : "";

  return {
    ok,
    engineCount: engineBySymbol.size,
    renderedCount: renderedBySymbol.size,
    fxLegCount: fxLegs.length,
    missingInUi,
    extraInUi,
    quantityMismatches,
    duplicateRows,
    renderedTotal: round2(renderedTotal),
    investedTotal: round2(investedTotal),
    totalsDelta,
    tolerance,
    summary: ok
      ? `${engineBySymbol.size} position${engineBySymbol.size === 1 ? "" : "s"} reconciled${fxNote}`
      : `Display mismatch — ${problems.join("; ")}${fxNote}`,
  };
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
