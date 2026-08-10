import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type {
  BreakoutDiagnostics,
  SignalSlice,
  SymbolDiagnostic,
} from "@/lib/breakout-diagnostics";

const pct = (v: number, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
const tone = (v: number) => (v >= 0 ? "text-emerald-500" : "text-red-500");

function SliceCells({ slice }: { slice: SignalSlice }) {
  if (!slice.trades) {
    return (
      <>
        <td className="py-1 pr-3 text-right text-muted-foreground">—</td>
        <td className="py-1 pr-3 text-right text-muted-foreground">—</td>
        <td className="py-1 pr-3 text-right text-muted-foreground">—</td>
      </>
    );
  }
  return (
    <>
      <td className="py-1 pr-3 text-right tabular-nums">{slice.trades}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{slice.winRatePct.toFixed(0)}%</td>
      <td className={`py-1 pr-3 text-right tabular-nums ${tone(slice.avgReturnPct)}`}>
        {pct(slice.avgReturnPct)}
      </td>
    </>
  );
}

const ROLE_TONE: Record<SymbolDiagnostic["role"], string> = {
  driver: "border-emerald-500/40 text-emerald-500",
  drag: "border-red-500/40 text-red-500",
  neutral: "border-border text-muted-foreground",
  thin: "border-border text-muted-foreground",
};

/**
 * Per-symbol and per-signal-state breakdown of a breakout backtest — shows
 * which names and which breakout states create the confirmed-vs-failed gap.
 */
export function BreakoutDiagnosticsSection({
  diagnostics,
}: {
  diagnostics: BreakoutDiagnostics;
}) {
  const [tab, setTab] = useState<"symbols" | "states">("symbols");
  if (!diagnostics.symbols.length && !diagnostics.states.length) return null;

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-3" data-testid="breakout-diagnostics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium">Diagnostics</p>
          <p className="text-[11px] text-muted-foreground">
            Which symbols and which breakout states drive the confirmed vs failed gap.
          </p>
        </div>
        <div className="flex gap-1">
          {(["symbols", "states"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`rounded-md border px-2 py-1 text-[11px] capitalize ${
                tab === t
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              {t === "symbols" ? "Per symbol" : "Per signal"}
            </button>
          ))}
        </div>
      </div>

      {diagnostics.notes.length > 0 && (
        <ul className="space-y-1 text-[11px] text-muted-foreground">
          {diagnostics.notes.map((n) => (
            <li key={n}>• {n}</li>
          ))}
        </ul>
      )}

      {tab === "symbols" ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-xs" data-testid="breakout-symbol-table">
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 text-left font-normal">Symbol</th>
                <th className="py-1 pr-3 text-right font-normal">Conf n</th>
                <th className="py-1 pr-3 text-right font-normal">Conf win</th>
                <th className="py-1 pr-3 text-right font-normal">Conf avg</th>
                <th className="py-1 pr-3 text-right font-normal">Fail n</th>
                <th className="py-1 pr-3 text-right font-normal">Fail win</th>
                <th className="py-1 pr-3 text-right font-normal">Fail avg</th>
                <th className="py-1 pr-3 text-right font-normal">Gap</th>
                <th className="py-1 text-right font-normal">P&amp;L share</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.symbols.map((s) => (
                <tr key={s.symbol} className="border-t border-border/40">
                  <td className="py-1 pr-3">
                    <span className="flex items-center gap-1">
                      <span className="font-medium">{s.symbol}</span>
                      <Badge variant="outline" className={`px-1 py-0 text-[10px] ${ROLE_TONE[s.role]}`}>
                        {s.role}
                      </Badge>
                    </span>
                  </td>
                  <SliceCells slice={s.confirmed} />
                  <SliceCells slice={s.failed} />
                  <td className={`py-1 pr-3 text-right tabular-nums ${tone(s.avgReturnGapPct)}`}>
                    {pct(s.avgReturnGapPct)}
                  </td>
                  <td className={`py-1 text-right tabular-nums ${tone(s.confirmedContributionPct)}`}>
                    {s.confirmedContributionPct >= 0 ? "+" : ""}
                    {s.confirmedContributionPct.toFixed(0)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-3" data-testid="breakout-state-blocks">
          {diagnostics.states.map((st) => (
            <div key={st.cohort} className="rounded-md border border-border/40 p-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xs font-medium capitalize">{st.cohort}</p>
                <p className="text-[11px] text-muted-foreground">
                  {st.overall.trades} signals · stop {st.stopRatePct.toFixed(0)}% · target{" "}
                  {st.targetRatePct.toFixed(0)}% · avg worst {st.avgMaxAdversePct.toFixed(2)}%
                </p>
              </div>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full min-w-[420px] text-xs">
                  <thead className="text-[11px] text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 text-left font-normal">Split</th>
                      <th className="py-1 pr-3 text-right font-normal">Signals</th>
                      <th className="py-1 pr-3 text-right font-normal">Win rate</th>
                      <th className="py-1 text-right font-normal">Avg return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ...st.byDirection.map((d) => ({
                        label: d.direction === "up" ? "Upside break" : "Downside break",
                        slice: d.slice,
                      })),
                      ...st.byQuality.map((q) => ({
                        label: `${q.bucket} quality`,
                        slice: q.slice,
                      })),
                      ...st.byExitReason.map((e) => ({
                        label: `exit: ${e.reason}`,
                        slice: e.slice,
                      })),
                    ].map((row) => (
                      <tr key={`${st.cohort}-${row.label}`} className="border-t border-border/30">
                        <td className="py-1 pr-3 capitalize">{row.label}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{row.slice.trades}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {row.slice.winRatePct.toFixed(0)}%
                        </td>
                        <td className={`py-1 text-right tabular-nums ${tone(row.slice.avgReturnPct)}`}>
                          {pct(row.slice.avgReturnPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
