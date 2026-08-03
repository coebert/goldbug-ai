import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getExecutionQuality } from "@/lib/execution-quality.functions";
import type {
  FillRateBucket,
  SlippageBucket,
  SliceAdherenceBucket,
} from "@/lib/execution-quality.server";

const WINDOWS = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
];

interface Props {
  portfolioId: string;
}

export function ExecutionQualityCard({ portfolioId }: Props) {
  const [windowDays, setWindowDays] = useState(30);
  const fetchFn = useServerFn(getExecutionQuality);
  const q = useQuery({
    queryKey: ["execution-quality", portfolioId, windowDays],
    queryFn: () => fetchFn({ data: { portfolioId, windowDays } }),
  });

  const data = q.data;

  return (
    <Card>
      <CardHeader className="flex flex-col items-start gap-3 pb-3 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="text-base">Execution quality</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Fill rate, slippage vs limit price, and parent-slice adherence for buy and sell orders.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.value}
              size="sm"
              variant={windowDays === w.value ? "default" : "outline"}
              onClick={() => setWindowDays(w.value)}
              className="h-7 px-2 text-xs"
            >
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {data && data.totalOrders === 0 && data.totalSlicePrograms === 0 && (
          <p className="text-sm text-muted-foreground">
            No live orders or slice programs in the last {data.windowDays} days.
          </p>
        )}
        {data && (data.totalOrders > 0 || data.totalSlicePrograms > 0) && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{data.totalOrders} orders</Badge>
              <Badge variant="outline">{data.totalFills} fills</Badge>
              <Badge variant="outline">{data.totalSlicePrograms} slice programs</Badge>
            </div>

            <Section title="Fill rate" note="(filled + partial) / (total − pending). Full-fill = 100% completed.">
              <Table
                head={["Side", "Total", "Filled", "Partial", "Rejected", "Cancelled", "Pending", "Full-fill", "Fill rate"]}
                rows={data.fillRate.map((r: FillRateBucket) => [
                  cap(r.side),
                  String(r.total),
                  String(r.filled),
                  String(r.partial),
                  String(r.rejected),
                  String(r.cancelled),
                  String(r.pending),
                  fmtPct(r.fullFillRatePct),
                  fmtPct(r.fillRatePct),
                ])}
                emphasise={{ 8: (v) => toneFromPct(v), 7: (v) => toneFromPct(v) }}
              />
            </Section>

            <Section title="Slippage vs limit price" note="Bps against limit (positive = worse for us). Only LIMIT orders with fills are counted.">
              <Table
                head={["Side", "Samples", "Avg", "Median", "P95", "Best", "Worst"]}
                rows={data.slippage.map((r: SlippageBucket) => [
                  cap(r.side),
                  String(r.samples),
                  fmtBps(r.avgBps),
                  fmtBps(r.medianBps),
                  fmtBps(r.p95Bps),
                  fmtBps(r.bestBps),
                  fmtBps(r.worstBps),
                ])}
                emphasise={{ 2: (v) => toneFromSlippage(v), 3: (v) => toneFromSlippage(v), 4: (v) => toneFromSlippage(v) }}
              />
            </Section>

            <Section title="Slice adherence" note="Progress across parent-slice programs. Completion = programs that reached status='filled'.">
              <Table
                head={["Side", "Programs", "Filled", "Active", "Expired", "Cancelled", "Avg progress", "Completion"]}
                rows={data.slice.map((r: SliceAdherenceBucket) => [
                  cap(r.side),
                  String(r.programs),
                  String(r.filled),
                  String(r.active),
                  String(r.expired),
                  String(r.cancelled),
                  fmtPct(r.avgProgressPct),
                  fmtPct(r.completionRatePct),
                ])}
                emphasise={{ 6: (v) => toneFromPct(v), 7: (v) => toneFromPct(v) }}
              />
            </Section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{note}</div>
      </div>
      {children}
    </div>
  );
}

function Table({
  head,
  rows,
  emphasise,
}: {
  head: string[];
  rows: string[][];
  emphasise?: Record<number, (v: string) => "pos" | "neg" | undefined>;
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`px-2 py-1.5 ${i === 0 ? "text-left" : "text-right"} font-medium`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={ri === 0 ? "bg-muted/20 font-medium" : ""}>
              {row.map((cell, ci) => {
                const tone = emphasise?.[ci]?.(cell);
                return (
                  <td
                    key={ci}
                    className={`px-2 py-1.5 ${ci === 0 ? "text-left" : "text-right tabular-nums"} ${
                      tone === "pos" ? "text-emerald-500" : tone === "neg" ? "text-destructive" : ""
                    }`}
                  >
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fmtPct(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}
function fmtBps(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)} bps`;
}
function toneFromPct(v: string): "pos" | "neg" | undefined {
  if (v === "—") return undefined;
  const n = Number(v.replace("%", ""));
  if (!Number.isFinite(n)) return undefined;
  if (n >= 90) return "pos";
  if (n < 60) return "neg";
  return undefined;
}
function toneFromSlippage(v: string): "pos" | "neg" | undefined {
  if (v === "—") return undefined;
  const n = Number(v.replace(" bps", ""));
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return "pos";
  if (n > 15) return "neg";
  return undefined;
}
