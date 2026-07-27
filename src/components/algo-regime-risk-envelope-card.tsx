import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SlidersHorizontal } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  getClampsForRisk,
  type RiskLevel,
} from "@/lib/microstructure/algo-regime-autotune";
import { DEFAULT_ALGO_REGIME_CONFIG } from "@/lib/microstructure/algo-regime";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

type TunedKey =
  | "volBurstRatio"
  | "liquidityVacuumRatio"
  | "whipsawFlipsThreshold"
  | "correlationSpikeThreshold";

const TUNED_KEYS: readonly TunedKey[] = [
  "volBurstRatio",
  "liquidityVacuumRatio",
  "whipsawFlipsThreshold",
  "correlationSpikeThreshold",
] as const;

const KEY_META: Record<
  TunedKey,
  { label: string; unit: string; hint: string; fmt: (n: number) => string }
> = {
  volBurstRatio: {
    label: "Vol burst ratio",
    unit: "×",
    hint: "Short-window realised vol vs 20d baseline. Lower = more sensitive.",
    fmt: (n) => n.toFixed(2),
  },
  liquidityVacuumRatio: {
    label: "Liquidity vacuum ratio",
    unit: "×",
    hint: "Volume vs rolling median. Higher = more sensitive (fires sooner).",
    fmt: (n) => n.toFixed(2),
  },
  whipsawFlipsThreshold: {
    label: "Whipsaw flips",
    unit: "flips",
    hint: "Sign flips over 30 bars. Lower = more sensitive.",
    fmt: (n) => n.toFixed(0),
  },
  correlationSpikeThreshold: {
    label: "Correlation spike",
    unit: "|ρ|",
    hint: "Avg pairwise |corr|. Lower = more sensitive.",
    fmt: (n) => n.toFixed(2),
  },
};

const RISK_LEVELS: readonly RiskLevel[] = ["conservative", "balanced", "aggressive"] as const;

// Okabe–Ito, CVD-safe
const RISK_COLOR: Record<RiskLevel, string> = {
  conservative: "#0072B2", // blue
  balanced: "#009E73", // bluish green
  aggressive: "#D55E00", // vermillion
};

// -----------------------------------------------------------------------------
// Data
// -----------------------------------------------------------------------------

function normaliseRisk(raw: string | null | undefined): RiskLevel {
  const r = (raw ?? "balanced").toLowerCase();
  if (r === "conservative" || r === "balanced" || r === "aggressive") return r;
  return "balanced";
}

function useRiskLevel(portfolioId: string) {
  return useQuery({
    queryKey: ["portfolio-risk-level", portfolioId],
    queryFn: async (): Promise<RiskLevel> => {
      const { data, error } = await supabase
        .from("portfolios")
        .select("risk_level")
        .eq("id", portfolioId)
        .single();
      if (error) throw error;
      return normaliseRisk(data?.risk_level as string | null);
    },
    staleTime: 60_000,
  });
}

// -----------------------------------------------------------------------------
// Envelope math
// -----------------------------------------------------------------------------

type EnvelopeCell = {
  min: number;
  max: number;
  step: number;
  driftLo: number;
  driftHi: number;
};

function buildEnvelope(risk: RiskLevel, key: TunedKey): EnvelopeCell {
  const c = getClampsForRisk(risk);
  const range = c[key];
  const drift = c.maxDrift[key];
  const def = DEFAULT_ALGO_REGIME_CONFIG[key];
  return {
    min: range.min,
    max: range.max,
    step: range.step,
    driftLo: def - drift,
    driftHi: def + drift,
  };
}

// Compute a shared axis per key across all three risk levels + default so the
// bars are visually comparable at a glance.
function computeAxis(key: TunedKey) {
  const def = DEFAULT_ALGO_REGIME_CONFIG[key];
  let lo = def;
  let hi = def;
  for (const risk of RISK_LEVELS) {
    const e = buildEnvelope(risk, key);
    lo = Math.min(lo, e.min, e.driftLo);
    hi = Math.max(hi, e.max, e.driftHi);
  }
  const pad = (hi - lo) * 0.06;
  return { lo: lo - pad, hi: hi + pad, def };
}

// -----------------------------------------------------------------------------
// Row: three horizontal bars stacked (one per risk level) sharing an X-axis
// -----------------------------------------------------------------------------

function EnvelopeRow({
  metricKey,
  activeRisk,
}: {
  metricKey: TunedKey;
  activeRisk: RiskLevel;
}) {
  const meta = KEY_META[metricKey];
  const axis = useMemo(() => computeAxis(metricKey), [metricKey]);
  const pctOf = (v: number) => ((v - axis.lo) / (axis.hi - axis.lo)) * 100;
  const defPct = pctOf(axis.def);

  return (
    <div className="space-y-2 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{meta.label}</div>
          <div className="text-[11px] text-muted-foreground">{meta.hint}</div>
        </div>
        <div className="text-[11px] tabular-nums text-muted-foreground">
          default {meta.fmt(axis.def)} {meta.unit}
        </div>
      </div>

      <div
        role="img"
        aria-label={`Envelope for ${meta.label}. Default ${meta.fmt(axis.def)}. ${RISK_LEVELS.map(
          (r) => {
            const e = buildEnvelope(r, metricKey);
            return `${r} clamp ${meta.fmt(e.min)} to ${meta.fmt(e.max)}, step ${meta.fmt(e.step)}, max drift ±${meta.fmt(e.driftHi - axis.def)}`;
          },
        ).join("; ")}.`}
        className="rounded-md border bg-muted/20 p-2"
      >
        {RISK_LEVELS.map((risk) => {
          const e = buildEnvelope(risk, metricKey);
          const clampL = pctOf(e.min);
          const clampR = pctOf(e.max);
          const driftL = Math.max(clampL, pctOf(e.driftLo));
          const driftR = Math.min(clampR, pctOf(e.driftHi));
          const isActive = risk === activeRisk;
          const color = RISK_COLOR[risk];
          // Step tick width relative to axis, min 2px
          const stepWidth = Math.max(
            2,
            (e.step / (axis.hi - axis.lo)) * 100,
          );

          return (
            <div
              key={risk}
              className={`group flex items-center gap-2 py-1.5 ${
                isActive ? "opacity-100" : "opacity-70"
              }`}
            >
              <div className="w-24 shrink-0 text-[11px] font-medium tabular-nums">
                <span
                  aria-hidden
                  className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle"
                  style={{ background: color }}
                />
                <span className={isActive ? "text-foreground" : "text-muted-foreground"}>
                  {risk}
                </span>
                {isActive && (
                  <Badge
                    variant="secondary"
                    className="ml-1 h-4 px-1 text-[9px] uppercase"
                  >
                    active
                  </Badge>
                )}
              </div>

              <div className="relative h-6 flex-1 rounded-sm bg-background ring-1 ring-inset ring-border">
                {/* clamp band */}
                <div
                  className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm"
                  style={{
                    left: `${clampL}%`,
                    width: `${Math.max(0.5, clampR - clampL)}%`,
                    background: color,
                    opacity: isActive ? 0.28 : 0.18,
                  }}
                />
                {/* drift band (inner, saturated) */}
                <div
                  className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm"
                  style={{
                    left: `${driftL}%`,
                    width: `${Math.max(0.5, driftR - driftL)}%`,
                    background: color,
                    opacity: isActive ? 0.75 : 0.45,
                  }}
                  title={`Max drift band (±${KEY_META[metricKey].fmt(e.driftHi - axis.def)} from default)`}
                />
                {/* step-size tick at the default, on top of bands */}
                <div
                  className="absolute top-1/2 h-4 -translate-x-1/2 -translate-y-1/2 rounded-sm ring-1 ring-inset ring-background"
                  style={{
                    left: `${defPct}%`,
                    width: `${stepWidth}%`,
                    background: color,
                  }}
                  title={`Step size ${KEY_META[metricKey].fmt(e.step)} ${meta.unit}`}
                />
                {/* default marker */}
                <div
                  className="absolute top-0 bottom-0 w-px bg-foreground/50"
                  style={{ left: `${defPct}%` }}
                  aria-hidden
                />
              </div>

              <div className="hidden w-40 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground md:block">
                {meta.fmt(e.min)}–{meta.fmt(e.max)} · ±{meta.fmt(e.driftHi - axis.def)}{" "}
                · step {meta.fmt(e.step)}
              </div>
            </div>
          );
        })}
      </div>

      {/* mobile: values table for small screens where the trailing text is hidden */}
      <div className="md:hidden overflow-hidden rounded-md border text-[11px]">
        <table className="w-full">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Risk</th>
              <th className="px-2 py-1 text-right font-medium">Clamp</th>
              <th className="px-2 py-1 text-right font-medium">±Drift</th>
              <th className="px-2 py-1 text-right font-medium">Step</th>
            </tr>
          </thead>
          <tbody>
            {RISK_LEVELS.map((risk) => {
              const e = buildEnvelope(risk, metricKey);
              return (
                <tr key={risk} className="border-t">
                  <td className="px-2 py-1">
                    <span
                      aria-hidden
                      className="mr-1 inline-block h-2 w-2 rounded-sm align-middle"
                      style={{ background: RISK_COLOR[risk] }}
                    />
                    {risk}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {meta.fmt(e.min)}–{meta.fmt(e.max)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    ±{meta.fmt(e.driftHi - axis.def)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{meta.fmt(e.step)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Card
// -----------------------------------------------------------------------------

export function AlgoRegimeRiskEnvelopeCard({ portfolioId }: { portfolioId: string }) {
  const q = useRiskLevel(portfolioId);
  const active = q.data ?? "balanced";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="h-4 w-4" /> Auto-tuner envelope by risk level
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          How this portfolio's <strong>risk level</strong> shapes what the auto-tuner
          is allowed to do. The vertical line is the shipped default; the outer band
          is the hard clamp, the inner saturated band is the cumulative{" "}
          <code className="text-[10px]">maxDrift</code> guard against tier-ladder inversion,
          and the small block at the default shows the per-cycle step size.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">Active risk level:</span>
          {RISK_LEVELS.map((r) => (
            <Badge
              key={r}
              variant={r === active ? "default" : "outline"}
              className="font-normal"
              style={
                r === active
                  ? { background: RISK_COLOR[r], color: "white", borderColor: RISK_COLOR[r] }
                  : { borderColor: RISK_COLOR[r], color: RISK_COLOR[r] }
              }
            >
              {r}
            </Badge>
          ))}
          {q.isLoading && (
            <span className="text-muted-foreground">loading portfolio…</span>
          )}
          {q.isError && (
            <span className="text-destructive">
              could not read risk_level — showing balanced defaults
            </span>
          )}
        </div>

        <div className="divide-y">
          {TUNED_KEYS.map((k) => (
            <EnvelopeRow key={k} metricKey={k} activeRisk={active} />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            Clamp = hard min/max the tuner can propose
          </Badge>
          <Badge variant="outline" className="font-normal">
            maxDrift = how far cumulative nudges may leave the default
          </Badge>
          <Badge variant="outline" className="font-normal">
            Step = per-cycle nudge size
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
