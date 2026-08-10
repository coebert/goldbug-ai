import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type {
  BreakoutDiagnostics,
  RegimeVolContext,
  SignalSlice,
  SymbolDiagnostic,
} from "@/lib/breakout-diagnostics";
import type { BreakoutTimingReport, BucketRow } from "@/lib/breakout-timing";

const pct = (v: number, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
const tone = (v: number) => (v >= 0 ? "text-emerald-500" : "text-red-500");

const GATE_TONE: Record<string, string> = {
  skip: "border-red-500/40 text-red-500",
  downsize: "border-amber-500/40 text-amber-500",
  trade: "border-emerald-500/40 text-emerald-500",
};

const volTxt = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(2)}%/day`);

/**
 * The regime cells and volatility measurements sitting under a diagnostic
 * group, so a performance gap can be attributed to regime gating, sideways
 * tape or the high-vol downsize rule rather than guessed at.
 */
function RegimeVolCells({ ctx, label }: { ctx: RegimeVolContext; label?: string }) {
  if (!ctx.cells.length) return null;
  return (
    <div className="mt-2 rounded-md border border-border/40 bg-muted/20 p-2" data-testid="regime-vol-cells">
      <p className="text-[11px] text-muted-foreground">
        {label ? `${label} — ` : ""}
        {ctx.summary}
      </p>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead className="text-[11px] text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 text-left font-normal">Regime cell</th>
              <th className="py-1 pr-3 text-right font-normal">n</th>
              <th className="py-1 pr-3 text-right font-normal">Share</th>
              <th className="py-1 pr-3 text-right font-normal">Win</th>
              <th className="py-1 pr-3 text-right font-normal">Expectancy</th>
              <th className="py-1 pr-3 text-right font-normal">Realised vol</th>
              <th className="py-1 pr-3 text-right font-normal">High-vol</th>
              <th className="py-1 text-left font-normal">Live gate</th>
            </tr>
          </thead>
          <tbody>
            {ctx.cells.map((c) => (
              <tr key={c.regime} className="border-t border-border/30 align-top">
                <td className="py-1 pr-3 capitalize">{c.regime}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{c.slice.trades}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{c.sharePct.toFixed(0)}%</td>
                <td className="py-1 pr-3 text-right tabular-nums">{c.slice.winRatePct.toFixed(0)}%</td>
                <td className={`py-1 pr-3 text-right tabular-nums ${tone(c.slice.avgReturnPct)}`}>
                  {pct(c.slice.avgReturnPct)}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{volTxt(c.avgRealisedVol20d)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {c.highVolSharePct.toFixed(0)}%
                </td>
                <td className="py-1">
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge
                      variant="outline"
                      className={`px-1 py-0 text-[10px] ${GATE_TONE[c.gate.action] ?? ""}`}
                    >
                      {c.gate.action === "trade" ? "full size" : c.gate.action}
                      {c.gate.action !== "trade" && ` ×${c.gate.mult.toFixed(2)}`}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">{c.gate.reason}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


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
function BucketTable({ title, rows }: { title: string; rows: BucketRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="min-w-[220px] flex-1">
      <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
      <table className="mt-1 w-full text-xs">
        <thead className="text-[11px] text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 text-left font-normal">Band</th>
            <th className="py-1 pr-2 text-right font-normal">n</th>
            <th className="py-1 pr-2 text-right font-normal">Win</th>
            <th className="py-1 text-right font-normal">Avg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-border/30">
              <td className="py-1 pr-2">{r.label}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{r.slice.trades}</td>
              <td className="py-1 pr-2 text-right tabular-nums">
                {r.slice.winRatePct.toFixed(0)}%
              </td>
              <td className={`py-1 text-right tabular-nums ${tone(r.expectancyPct)}`}>
                {pct(r.expectancyPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BreakoutDiagnosticsSection({
  diagnostics,
  timing,
}: {
  diagnostics: BreakoutDiagnostics;
  timing?: BreakoutTimingReport;
}) {
  const [tab, setTab] = useState<"symbols" | "states" | "timing">("symbols");
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
          {(timing ? (["symbols", "states", "timing"] as const) : (["symbols", "states"] as const)).map((t) => (
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
              {t === "symbols" ? "Per symbol" : t === "states" ? "Per signal" : "Timing"}
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

      {tab === "timing" && timing ? (
        <div className="space-y-3" data-testid="breakout-timing-blocks">
          {timing.cohorts.map((c) => (
            <div key={c.cohort} className="rounded-md border border-border/40 p-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xs font-medium capitalize">{c.cohort}</p>
                <p className="text-[11px] text-muted-foreground">
                  {c.overall.trades} signals · avg age {c.avgAgeBars.toFixed(1)}b ·{" "}
                  {c.avgPendingLatencyBars == null
                    ? "no pending lead-in"
                    : `resolves ${c.avgPendingLatencyBars.toFixed(1)}b after pending`}{" "}
                  · decay {c.ageDecayPctPerBar >= 0 ? "+" : ""}
                  {c.ageDecayPctPerBar.toFixed(3)}%/bar
                </p>
              </div>
              <div className="mt-1 flex flex-wrap gap-4">
                <BucketTable title="By signal age at entry" rows={c.byAge} />
                <BucketTable title="By pending → resolution" rows={c.byPendingLatency} />
                <BucketTable title="By realised hold time" rows={c.byHoldTime} />
              </div>
            </div>
          ))}
          {timing.recommended.map((r) => (
            <div key={r.cohort} className="rounded-md border border-primary/30 bg-primary/5 p-2">
              <p className="text-xs font-medium capitalize">
                Recommended {r.cohort} age mapping
                {r.staleAgeBars != null && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    · stale from {r.staleAgeBars} bars
                  </span>
                )}
              </p>
              <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                {r.rules.map((rule) => (
                  <li key={`${rule.minAgeBars}-${rule.maxAgeBars}`}>
                    age {rule.minAgeBars}–
                    {Number.isFinite(rule.maxAgeBars) ? rule.maxAgeBars : "+"} →{" "}
                    {rule.veto ? "skip" : `×${rule.mult.toFixed(2)}`} ({rule.reason})
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : tab === "symbols" ? (
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
              {diagnostics.symbols.map((s) => {
                const open = openSymbol === s.symbol;
                const ctx = s.confirmedRegimeVol.cells.length ? s.confirmedRegimeVol : s.regimeVol;
                return (
                  <>
                    <tr key={s.symbol} className="border-t border-border/40">
                      <td className="py-1 pr-3">
                        <button
                          type="button"
                          onClick={() => setOpenSymbol(open ? null : s.symbol)}
                          aria-expanded={open}
                          className="flex items-center gap-1 text-left"
                        >
                          <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
                          <span className="font-medium">{s.symbol}</span>
                          <Badge variant="outline" className={`px-1 py-0 text-[10px] ${ROLE_TONE[s.role]}`}>
                            {s.role}
                          </Badge>
                        </button>
                      </td>
                      <SliceCells slice={s.confirmed} />
                      <SliceCells slice={s.failed} />
                      <td className={`py-1 pr-3 text-right tabular-nums ${tone(s.avgReturnGapPct)}`}>
                        {pct(s.avgReturnGapPct)}
                      </td>
                      <td className={`py-1 pr-3 text-right tabular-nums ${tone(s.confirmedContributionPct)}`}>
                        {s.confirmedContributionPct >= 0 ? "+" : ""}
                        {s.confirmedContributionPct.toFixed(0)}%
                      </td>
                      <td className="py-1 text-right text-[11px] text-muted-foreground">
                        {s.regimeVol.sidewaysSharePct.toFixed(0)}% side ·{" "}
                        {volTxt(s.regimeVol.avgRealisedVol20d)} ·{" "}
                        {s.regimeVol.highVolSharePct.toFixed(0)}% hi-vol
                      </td>
                    </tr>
                    {open && (
                      <tr key={`${s.symbol}-cells`} className="border-t border-border/20">
                        <td colSpan={10} className="pb-2">
                          <RegimeVolCells ctx={ctx} label={`${s.symbol} confirmed cells`} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
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
