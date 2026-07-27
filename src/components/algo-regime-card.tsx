import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, ShieldAlert } from "lucide-react";
import type { AlgoRegimeSnapshot } from "@/lib/microstructure/algo-regime";

const TIER_STYLE: Record<AlgoRegimeSnapshot["tier"], string> = {
  normal: "text-emerald-500",
  elevated: "text-amber-500",
  extreme: "text-red-500",
};

const SIGNAL_LABEL: Record<string, string> = {
  volBurst: "Volatility burst",
  liquidityVacuum: "Liquidity vacuum",
  whipsaw: "Whipsaw / mean-reversion",
  correlationSpike: "Correlated de-risking",
  gapFade: "Gap-and-fade",
};

export function AlgoRegimeCard({ snapshot }: { snapshot: AlgoRegimeSnapshot | null | undefined }) {
  const s = snapshot;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4" /> Algo-regime guard
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Detects AI/algo-driven volatility bursts, liquidity vacuums, whipsaw and correlated de-risking.
          Adapts sizing, participation caps and tail hedge in real time.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!s && <p className="text-sm text-muted-foreground">No snapshot yet.</p>}
        {s && (
          <>
            <div className="flex items-center justify-between">
              <div className="text-sm">
                Current tier:{" "}
                <span className={`font-semibold uppercase ${TIER_STYLE[s.tier]}`}>{s.tier}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                <Activity className="mr-1 inline h-3 w-3" />
                {s.score}/5 signals
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {(["volBurst", "liquidityVacuum", "whipsaw", "correlationSpike", "gapFade"] as const).map((k) => (
                <div
                  key={k}
                  className={`rounded border px-2 py-1 ${s[k] ? "border-red-500/40 text-red-500" : "text-muted-foreground"}`}
                >
                  {s[k] ? "●" : "○"} {SIGNAL_LABEL[k]}
                </div>
              ))}
            </div>
            <div className="rounded-lg border p-3 text-xs space-y-1">
              <div className="font-medium text-muted-foreground">Applied guardrails</div>
              <div>Max participation: <span className="font-mono">{(s.multipliers.maxParticipation * 100).toFixed(1)}%</span></div>
              <div>Size scale: <span className="font-mono">×{s.multipliers.sizeScale.toFixed(2)}</span></div>
              <div>Tail-hedge boost: <span className="font-mono">+{(s.multipliers.tailHedgeBoostPctNav * 100).toFixed(2)}% NAV</span></div>
              <div>New buys: <span className="font-mono">{s.multipliers.blockNewBuys ? "BLOCKED" : "allowed"}</span></div>
            </div>
            <p className="text-xs text-muted-foreground">{s.reason}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
