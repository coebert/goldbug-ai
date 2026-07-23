import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getLearningDiagnostics } from "@/lib/insights.functions";
import { Brain } from "lucide-react";
import { Explain } from "@/components/explain";

const CATEGORY_LABEL: Record<string, string> = {
  cash_floor: "Cash floor",
  position_cap: "Position cap",
  class_cap: "Asset-class cap",
  correlation: "Correlation cap",
  new_pos_cap: "Daily new-position cap",
  no_price: "No price",
  no_holding: "No holding to sell",
  universe: "Universe filter",
  other: "Other",
};

export function LearningDiagnosticsCard({ portfolioId }: { portfolioId: string }) {
  const fetchFn = useServerFn(getLearningDiagnostics);
  const { data, isLoading } = useQuery({
    queryKey: ["learning-diagnostics", portfolioId],
    queryFn: () => fetchFn({ data: { portfolioId } }),
    staleTime: 60_000,
  });

  const pct = (n: number | null | undefined, digits = 2) =>
    n == null ? "—" : `${(n * 100).toFixed(digits)}%`;

  const calib = data?.calibration ?? null;
  const cf = data?.counterfactuals;
  const wf = data?.walk_forward ?? [];

  const brier = calib ? Number(calib.brier_score) : null;
  const brierGood = brier != null && brier < 0.2;
  const brierBad = brier != null && brier > 0.28;
  const mult = calib ? Number(calib.global_size_mult) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Brain className="h-4 w-4" /> AI learning diagnostics
          <Explain term="signal_importance">?</Explain>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!isLoading && (
          <>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">Calibration (K)</div>
              {calib ? (
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="rounded-lg border p-2">
                    <div className="text-xs text-muted-foreground">Brier</div>
                    <div className={brierGood ? "text-emerald-500 font-semibold" : brierBad ? "text-red-500 font-semibold" : "font-semibold"}>
                      {brier?.toFixed(3) ?? "—"}
                    </div>
                  </div>
                  <div className="rounded-lg border p-2">
                    <div className="text-xs text-muted-foreground">Hit rate</div>
                    <div className="font-semibold">{pct(calib.hit_rate == null ? null : Number(calib.hit_rate), 0)}</div>
                  </div>
                  <div className="rounded-lg border p-2">
                    <div className="text-xs text-muted-foreground">Global sizing</div>
                    <div className={mult < 1 ? "text-amber-500 font-semibold" : "font-semibold"}>×{mult.toFixed(2)}</div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Not enough evaluated trades yet.</p>
              )}
              {calib?.notes && <p className="text-xs text-muted-foreground mt-1">{calib.notes}</p>}
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">Counterfactuals (G)</div>
              {cf && cf.evaluated > 0 ? (
                <>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="rounded-lg border p-2">
                      <div className="text-xs text-muted-foreground">Evaluated</div>
                      <div className="font-semibold">{cf.evaluated}</div>
                    </div>
                    <div className="rounded-lg border p-2">
                      <div className="text-xs text-muted-foreground">Avg regret (5d)</div>
                      <div className={(cf.avg_regret_5d ?? 0) > 0 ? "text-red-500 font-semibold" : "text-emerald-500 font-semibold"}>
                        {pct(cf.avg_regret_5d)}
                      </div>
                    </div>
                    <div className="rounded-lg border p-2">
                      <div className="text-xs text-muted-foreground">Saved / costly</div>
                      <div className="font-semibold">
                        <span className="text-emerald-500">{cf.saved_blocks}</span> / <span className="text-red-500">{cf.costly_blocks}</span>
                      </div>
                    </div>
                  </div>
                  {cf.by_category.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {cf.by_category.slice(0, 5).map((r) => (
                        <div key={r.category} className="flex items-center justify-between text-xs">
                          <span>{CATEGORY_LABEL[r.category] ?? r.category} · {r.n}</span>
                          <span className={r.avg_return_5d > 0 ? "text-red-500" : "text-emerald-500"}>
                            {pct(r.avg_return_5d)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No evaluated blocked trades yet (5-day window pending).</p>
              )}
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">Walk-forward tuning (F)</div>
              {wf.length > 0 ? (
                <div className="space-y-1">
                  {wf.map((r, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{String(r.tuned_at).slice(0, 10)}</span>
                      <span className="font-mono">oos {r.oos_score == null ? "—" : Number(r.oos_score).toFixed(3)} · sma {r.sma_fast}/{r.sma_slow} · kelly {Number(r.kelly_cap).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">First tuning run will appear after the next hourly cycle.</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
