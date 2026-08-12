import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getTranslationQuality,
  type TranslationQualityResult,
  type LanguageSeries,
} from "@/lib/translation-quality.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Languages, RefreshCw } from "lucide-react";
import { AXIS_LINE, AXIS_TICK, GRID_PROPS, LEGEND_PROPS, TICK_LINE } from "@/lib/chart-palette";

const COLORS = [
  "var(--primary)",
  "var(--destructive)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-1)",
  "var(--muted-foreground)",
];

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}
function conf(n: number): string {
  return n.toFixed(2);
}
function toneForConfidence(c: number): "default" | "secondary" | "destructive" {
  if (c >= 0.85) return "default";
  if (c >= 0.6) return "secondary";
  return "destructive";
}

interface ChartPoint {
  day: string;
  [lang: string]: string | number;
}

function buildChartData(result: TranslationQualityResult, langs: LanguageSeries[]): ChartPoint[] {
  return result.days.map((day) => {
    const row: ChartPoint = { day: day.slice(5) };
    for (const l of langs) {
      const p = l.points.find((x) => x.day === day);
      row[l.language] = p && p.count > 0 ? Number(p.avgConfidence.toFixed(3)) : NaN;
    }
    return row;
  });
}

export function TranslationQualityCard() {
  const fn = useServerFn(getTranslationQuality);
  const [sinceDays, setSinceDays] = useState<number>(30);
  const [minCount, setMinCount] = useState<number>(3);

  const query = useQuery({
    queryKey: ["translation-quality", sinceDays, minCount],
    queryFn: () => fn({ data: { sinceDays, minCount } }),
    staleTime: 60_000,
  });

  const result = query.data;
  const topLangs = useMemo(() => (result ? result.languages.slice(0, 6) : []), [result]);
  const chartData = useMemo(
    () => (result ? buildChartData(result, topLangs) : []),
    [result, topLangs],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2">
            <Languages className="h-4 w-4" />
            Translation quality by language
          </span>
          <div className="flex items-center gap-2">
            <Select value={String(sinceDays)} onValueChange={(v) => setSinceDays(Number(v))}>
              <SelectTrigger className="h-8 w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="14">Last 14 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Select value={String(minCount)} onValueChange={(v) => setMinCount(Number(v))}>
              <SelectTrigger className="h-8 w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Min 1 headline</SelectItem>
                <SelectItem value="3">Min 3 headlines</SelectItem>
                <SelectItem value="5">Min 5 headlines</SelectItem>
                <SelectItem value="10">Min 10 headlines</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading translation stats…</p>
        ) : query.isError ? (
          <p className="text-sm text-destructive">
            Failed to load: {(query.error as Error).message}
          </p>
        ) : !result || result.totalTranslated === 0 ? (
          <p className="text-sm text-muted-foreground">
            No translated headlines in the selected window yet.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Translated headlines" value={result.totalTranslated.toLocaleString()} />
              <Stat
                label="Overall avg confidence"
                value={conf(result.overallAvgConfidence)}
                badge={
                  <Badge variant={toneForConfidence(result.overallAvgConfidence)}>
                    {pct(result.overallAvgConfidence)}
                  </Badge>
                }
              />
              <Stat label="Languages" value={String(result.languages.length)} />
              <Stat label="Window" value={`${result.sinceDays}d`} />
            </div>

            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="day" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={TICK_LINE} />
                  <YAxis
                    width={64}
                    domain={[0, 1]}
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      fontSize: 12,
                      color: "var(--popover-foreground)",
                    }}
                    formatter={(v: number | string) =>
                      typeof v === "number" && !Number.isNaN(v) ? v.toFixed(2) : "—"
                    }
                  />
                  <Legend {...LEGEND_PROPS} />
                  {topLangs.map((l, i) => (
                    <Line
                      key={l.language}
                      type="monotone"
                      dataKey={l.language}
                      stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">Language summary</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Language</TableHead>
                    <TableHead className="text-right">Headlines</TableHead>
                    <TableHead className="text-right">Avg conf.</TableHead>
                    <TableHead className="text-right">Low-conf (&lt;0.60)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.languages.map((l) => (
                    <TableRow key={l.language}>
                      <TableCell className="font-medium uppercase">{l.language}</TableCell>
                      <TableCell className="text-right">{l.totalCount}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={toneForConfidence(l.avgConfidence)}>
                          {conf(l.avgConfidence)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {l.lowCount}{" "}
                        <span className="text-muted-foreground">({pct(l.lowShare)})</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">
                Lowest-confidence sources
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ≥ {result.minCount} headlines
                </span>
              </h4>
              {result.worstSources.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No source meets the minimum-headline threshold yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead>Lang</TableHead>
                      <TableHead className="text-right">Headlines</TableHead>
                      <TableHead className="text-right">Avg conf.</TableHead>
                      <TableHead className="text-right">Low-conf share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.worstSources.map((s) => (
                      <TableRow key={`${s.source}::${s.language}`}>
                        <TableCell className="max-w-[280px] truncate" title={s.source}>
                          {s.source}
                        </TableCell>
                        <TableCell className="uppercase">{s.language}</TableCell>
                        <TableCell className="text-right">{s.count}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={toneForConfidence(s.avgConfidence)}>
                            {conf(s.avgConfidence)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{pct(s.lowShare)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, badge }: { label: string; value: string; badge?: React.ReactNode }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
        {value}
        {badge}
      </div>
    </div>
  );
}
