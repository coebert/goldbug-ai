// Interactive cluster × cluster spillover heatmap.
//
// The terminal report (`--spillover`) prints three separate ASCII grids: calm
// coupling, stress coupling, and the stress uplift. On screen they collapse into
// one grid with a layer switch, because the question is almost always "which
// pair tightens the most when the tape turns?" — and that is a comparison, not
// three lookups. Hovering (or focusing, for keyboards) any cell shows all three
// ρ values at once plus the window counts behind them, so a cell fitted on four
// stressed windows can be told apart from one fitted on forty.

import { useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  SpilloverHeatmapCell,
  SpilloverHeatmapResponse,
} from "@/lib/spillover-heatmap.functions";

export type SpilloverLayerKey = "calm" | "stress" | "delta";

const LAYERS: { key: SpilloverLayerKey; label: string; hint: string }[] = [
  { key: "calm", label: "Calm ρ", hint: "Coupling in windows the vol trigger left alone." },
  { key: "stress", label: "Stress ρ", hint: "Coupling in windows the vol trigger flagged." },
  { key: "delta", label: "Δ uplift", hint: "Stress minus calm — the contagion channel." },
];

const valueOf = (cell: SpilloverHeatmapCell, layer: SpilloverLayerKey): number | null =>
  layer === "calm" ? cell.calm : layer === "stress" ? cell.stress : cell.delta;

const fmt = (v: number | null, digits = 3) =>
  v === null || !Number.isFinite(v) ? "n/a" : v.toFixed(digits);

/** Short cluster labels keep the axis readable on a phone. */
const shortLabel = (c: string) =>
  c.length <= 8 ? c : c.split(/[-_ ]/).map((p) => p.slice(0, 4)).join("-").slice(0, 10);

/**
 * Colour ramp. Calm and stress are one-sided (0…max) on the primary hue; Δ is
 * diverging, because a pair that *decouples* under stress is a genuinely
 * different finding from one that merely fails to tighten.
 */
function cellStyle(v: number | null, layer: SpilloverLayerKey, max: number): React.CSSProperties {
  if (v === null || !Number.isFinite(v)) {
    return { backgroundColor: "var(--muted)", opacity: 0.4 };
  }
  const span = max > 0 ? max : 1;
  if (layer === "delta") {
    const t = Math.min(1, Math.abs(v) / span);
    const hue = v >= 0 ? "var(--accent)" : "var(--primary)";
    return {
      backgroundColor: `color-mix(in oklab, ${hue} ${(t * 100).toFixed(1)}%, var(--card))`,
    };
  }
  const t = Math.min(1, Math.max(0, v) / span);
  return {
    backgroundColor: `color-mix(in oklab, var(--primary) ${(t * 100).toFixed(1)}%, var(--card))`,
  };
}

type Hover = { row: number; col: number; x: number; y: number };

export type SpilloverHeatmapViewerProps = {
  data: SpilloverHeatmapResponse;
  className?: string;
};

export function SpilloverHeatmapViewer({ data, className }: SpilloverHeatmapViewerProps) {
  const [layer, setLayer] = useState<SpilloverLayerKey>("delta");
  const [hover, setHover] = useState<Hover | null>(null);
  const [pinned, setPinned] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const memberMap = useMemo(
    () => new Map(data.members.map((m) => [m.cluster, m.symbols])),
    [data.members],
  );

  const max = useMemo(() => {
    const vals = data.cells
      .flat()
      .map((c) => valueOf(c, layer))
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .map((v) => Math.abs(v));
    return vals.length ? Math.max(...vals) : 1;
  }, [data.cells, layer]);

  /** Strongest off-diagonal pair on the active layer — the headline finding. */
  const topPair = useMemo(() => {
    let best: { a: string; b: string; v: number } | null = null;
    for (let i = 0; i < data.clusters.length; i++) {
      for (let j = i + 1; j < data.clusters.length; j++) {
        const v = valueOf(data.cells[i]?.[j] ?? ({} as SpilloverHeatmapCell), layer);
        if (v === null || !Number.isFinite(v)) continue;
        if (!best || v > best.v) best = { a: data.clusters[i]!, b: data.clusters[j]!, v };
      }
    }
    return best;
  }, [data.cells, data.clusters, layer]);

  const active = hover ?? pinned;
  const activeCell = active ? data.cells[active.row]?.[active.col] : undefined;

  if (!data.clusters.length) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Cluster spillover</CardTitle>
          <CardDescription>
            Not enough overlapping price history to fit the coupling matrix
            {data.skippedSymbols.length
              ? ` (skipped ${data.skippedSymbols.join(", ")})`
              : ""}
            .
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const showCell = (row: number, col: number, e?: React.MouseEvent) => {
    const box = gridRef.current?.getBoundingClientRect();
    const target = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
    const x = box && target ? target.left - box.left + target.width / 2 : 0;
    const y = box && target ? target.top - box.top : 0;
    setHover({ row, col, x, y });
  };

  return (
    <Card className={className}>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Cluster spillover heatmap</CardTitle>
            <CardDescription>
              Rolling {data.window}-bar windows, step {data.step}, basis {data.basis} —{" "}
              {data.windows} windows ({data.stressWindows} stressed) over {data.bars} bars
              {data.from ? ` from ${data.from} to ${data.to}` : ""}.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Heatmap layer">
            {LAYERS.map((l) => (
              <Button
                key={l.key}
                size="sm"
                variant={layer === l.key ? "default" : "outline"}
                aria-pressed={layer === l.key}
                title={l.hint}
                onClick={() => setLayer(l.key)}
              >
                {l.label}
              </Button>
            ))}
          </div>
        </div>
        {topPair && (
          <p className="text-sm text-muted-foreground">
            Strongest cross-cluster channel on this layer:{" "}
            <span className="font-medium text-foreground">
              {topPair.a} ↔ {topPair.b}
            </span>{" "}
            at {fmt(topPair.v)}.
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <div ref={gridRef} className="relative inline-block min-w-full">
            <table className="w-full border-separate border-spacing-1 text-xs">
              <caption className="sr-only">
                Cluster by cluster correlation, {layer} layer. Each cell reports calm,
                stress and delta rho.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="sr-only">
                    Cluster
                  </th>
                  {data.clusters.map((c) => (
                    <th
                      key={c}
                      scope="col"
                      className="px-1 pb-1 text-[10px] font-medium text-muted-foreground"
                      title={memberMap.get(c)?.join(", ")}
                    >
                      {shortLabel(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.clusters.map((rowCluster, row) => (
                  <tr key={rowCluster}>
                    <th
                      scope="row"
                      className="pr-2 text-right text-[10px] font-medium text-muted-foreground whitespace-nowrap"
                      title={memberMap.get(rowCluster)?.join(", ")}
                    >
                      {shortLabel(rowCluster)}
                    </th>
                    {data.clusters.map((colCluster, col) => {
                      const cell = data.cells[row]?.[col];
                      const v = cell ? valueOf(cell, layer) : null;
                      const isActive =
                        active?.row === row && active?.col === col;
                      return (
                        <td key={colCluster} className="p-0">
                          <button
                            type="button"
                            className={cn(
                              "h-10 w-full min-w-[3.25rem] rounded-md border border-border/50 px-1",
                              "text-[11px] tabular-nums transition-shadow",
                              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              isActive && "ring-2 ring-ring",
                              row === col && "border-border",
                            )}
                            style={cellStyle(v, layer, max)}
                            aria-label={
                              `${rowCluster} to ${colCluster}: calm ${fmt(cell?.calm ?? null)}, `
                              + `stress ${fmt(cell?.stress ?? null)}, delta ${fmt(cell?.delta ?? null)}`
                            }
                            onMouseEnter={(e) => showCell(row, col, e)}
                            onMouseLeave={() => setHover(null)}
                            onFocus={(e) => {
                              const box = gridRef.current?.getBoundingClientRect();
                              const t = e.currentTarget.getBoundingClientRect();
                              setHover(
                                box
                                  ? { row, col, x: t.left - box.left + t.width / 2, y: t.top - box.top }
                                  : { row, col, x: 0, y: 0 },
                              );
                            }}
                            onBlur={() => setHover(null)}
                            onClick={() =>
                              setPinned((p) =>
                                p && p.row === row && p.col === col ? null : { row, col },
                              )
                            }
                          >
                            {fmt(v, 2)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            {hover && activeCell && (
              <div
                role="tooltip"
                className="pointer-events-none absolute z-20 w-56 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover p-3 text-xs shadow-lg"
                style={{ left: hover.x, top: Math.max(0, hover.y - 8) }}
              >
                <p className="mb-1 font-medium">
                  {data.clusters[hover.row]} ↔ {data.clusters[hover.col]}
                </p>
                <dl className="space-y-0.5 tabular-nums">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Calm ρ</dt>
                    <dd>{fmt(activeCell.calm)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Stress ρ</dt>
                    <dd>{fmt(activeCell.stress)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Δ uplift</dt>
                    <dd
                      className={cn(
                        activeCell.delta !== null && activeCell.delta > 0 && "text-accent",
                      )}
                    >
                      {activeCell.delta !== null && activeCell.delta > 0 ? "+" : ""}
                      {fmt(activeCell.delta)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {activeCell.pairs} symbol pair{activeCell.pairs === 1 ? "" : "s"} ·{" "}
                  {activeCell.calmWindows} calm / {activeCell.stressWindows} stressed windows
                  {activeCell.stressWindows > 0 && activeCell.stressWindows < 5
                    ? " · thin stress fit"
                    : ""}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span>{layer === "delta" ? "−" : "0"}</span>
          <div className="flex h-3 flex-1 min-w-[8rem] overflow-hidden rounded-sm">
            {Array.from({ length: 12 }, (_, i) => {
              const t = layer === "delta" ? (i / 11) * 2 - 1 : i / 11;
              return (
                <div
                  key={i}
                  className="flex-1"
                  style={cellStyle(t * max, layer, max)}
                />
              );
            })}
          </div>
          <span>{fmt(max, 2)}</span>
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: "var(--muted)", opacity: 0.4 }}
            />
            unobserved
          </span>
        </div>

        {/* Pinned detail — survives moving the pointer away, unlike the tooltip. */}
        {pinned && data.cells[pinned.row]?.[pinned.col] && (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {data.clusters[pinned.row]} ↔ {data.clusters[pinned.col]}
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => setPinned(null)}>
                Unpin
              </Button>
            </div>
            <p className="tabular-nums">
              calm {fmt(data.cells[pinned.row]![pinned.col]!.calm)} · stress{" "}
              {fmt(data.cells[pinned.row]![pinned.col]!.stress)} · Δ{" "}
              {fmt(data.cells[pinned.row]![pinned.col]!.delta)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.clusters[pinned.row]}: {memberMap.get(data.clusters[pinned.row]!)?.join(", ")}
              {pinned.row !== pinned.col && (
                <>
                  {" · "}
                  {data.clusters[pinned.col]}:{" "}
                  {memberMap.get(data.clusters[pinned.col]!)?.join(", ")}
                </>
              )}
            </p>
          </div>
        )}

        {data.skippedSymbols.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Skipped for thin history: {data.skippedSymbols.join(", ")}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
