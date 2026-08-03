import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { simulateRiskGuardrails } from "@/lib/risk-simulator.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sliders } from "lucide-react";
import { POLL } from "@/lib/query-keys";

interface Props {
  portfolioId: string;
  active?: boolean;
}

const KEYS = ["conservative", "balanced", "aggressive"] as const;
const LABEL: Record<(typeof KEYS)[number], string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

function fmt(n: number, ccy: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy,
    maximumFractionDigits: 0,
  }).format(n);
}
function pct(n: number) {
  return `${n.toFixed(0)}%`;
}

/**
 * Risk simulator: for each risk-level preset, shows how the next tick's
 * FX intent compilation would be shaped — turnover cap, tilt exposure
 * headroom, min-notional threshold, and per-currency single-tick cap,
 * plus a count of allowed vs skipped/trimmed intents using the most
 * recent decision's intents as a sample.
 */
export function RiskSimulatorCard({ portfolioId, active = true }: Props) {
  const run = useServerFn(simulateRiskGuardrails);
  const query = useQuery({
    queryKey: ["risk-simulator", portfolioId],
    queryFn: () => run({ data: { portfolioId } }),
    enabled: active,
    staleTime: 60_000,
    refetchInterval: POLL.SLOW,
  });

  const data = query.data;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sliders className="h-4 w-4" />
            Risk Simulator
          </CardTitle>
          {data && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="uppercase">
                current: {data.currentRiskLevel}
              </Badge>
              <span>
                NAV {fmt(data.navBase, data.baseCcy)} · sample{" "}
                {data.intentsSource === "last-decision"
                  ? `${data.intentSampleCount} intents from last decision`
                  : "no recent intents"}
              </span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {query.isLoading && (
          <div className="h-24 animate-pulse rounded-md bg-muted/40" />
        )}
        {query.isError && (
          <div className="text-sm text-destructive">
            Failed to simulate risk guardrails.
          </div>
        )}
        {data && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="text-left py-2 pr-3">Preset</th>
                  <th className="text-right py-2 px-3">Turnover cap</th>
                  <th className="text-right py-2 px-3">Tilt cap</th>
                  <th className="text-right py-2 px-3">Tilt headroom</th>
                  <th className="text-right py-2 px-3">Min notional</th>
                  <th className="text-right py-2 px-3">Per-ccy cap</th>
                  <th className="text-right py-2 px-3">Allowed</th>
                  <th className="text-right py-2 px-3">Min-notional rejects</th>
                  <th className="text-right py-2 pl-3">Turnover trims</th>
                </tr>
              </thead>
              <tbody>
                {data.presets.map((p) => {
                  const current =
                    p.key === (data.currentRiskLevel || "balanced").toLowerCase();
                  return (
                    <tr
                      key={p.key}
                      className={`border-b last:border-b-0 ${current ? "bg-muted/40" : ""}`}
                    >
                      <td className="py-2 pr-3 font-medium">
                        <div className="flex items-center gap-2">
                          {LABEL[p.key]}
                          {current && (
                            <Badge variant="outline" className="text-[10px] py-0">
                              current
                            </Badge>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {pct(p.guardrails.maxTurnoverPctOfNav)} NAV / tick
                        </div>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {fmt(p.caps.turnoverBase, data.baseCcy)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {fmt(p.caps.tiltCapBase, data.baseCcy)}
                        <div className="text-[10px] text-muted-foreground">
                          {pct(p.guardrails.maxTiltExposurePctOfNav)} NAV
                        </div>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        <span
                          className={
                            p.caps.tiltRemainingBase <= 0
                              ? "text-destructive"
                              : undefined
                          }
                        >
                          {fmt(p.caps.tiltRemainingBase, data.baseCcy)}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {fmt(p.guardrails.minNotionalBase, data.baseCcy)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {pct(p.guardrails.perCurrencyMaxPct)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {p.results.allowed}
                        <span className="text-muted-foreground"> / {p.results.total}</span>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        <span
                          className={
                            p.results.minNotionalRejects > 0
                              ? "text-amber-500"
                              : undefined
                          }
                        >
                          {p.results.minNotionalRejects}
                        </span>
                      </td>
                      <td className="py-2 pl-3 text-right tabular-nums">
                        {p.results.turnoverTrimmed + p.results.tiltTrimmed +
                          p.results.perCurrencyTrimmed}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Simulated against the last decision's intent set. Current non-base
              exposure {fmt(data.currentNonBaseExposureBase, data.baseCcy)}.
              Live ticks use the balanced preset today; switching risk levels
              here previews how caps and rejections would change.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
