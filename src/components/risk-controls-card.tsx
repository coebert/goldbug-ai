import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { updateRiskConfig } from "@/lib/trading.functions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import { ChevronDown, ShieldCheck, Gauge, SlidersHorizontal } from "lucide-react";
import { Explain } from "@/components/explain";

type AssetClass = "stock" | "etf" | "crypto" | "commodity" | "fx";

type RiskConfig = {
  asset_class_limits: Partial<Record<AssetClass, number>>;
  per_symbol_limit_pct: number | null;
  stop_loss_pct: number;
  take_profit_pct: number;
  atr_trailing_mult: number;
  max_hold_days: number;
  volatility_sizing: boolean;
  vol_target_pct: number;
  risk_level?: number;
};

const DEFAULTS: RiskConfig = {
  asset_class_limits: { stock: 0.6, etf: 0.8, crypto: 0.2, commodity: 0.3, fx: 0.3 },
  per_symbol_limit_pct: null,
  stop_loss_pct: 0.1,
  take_profit_pct: 0.25,
  atr_trailing_mult: 3,
  max_hold_days: 0,
  volatility_sizing: true,
  vol_target_pct: 0.015,
};

function parseCfg(raw: unknown): RiskConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const lvl = r.risk_level == null ? undefined : Number(r.risk_level);
  return {
    asset_class_limits: {
      ...DEFAULTS.asset_class_limits,
      ...(r.asset_class_limits as Partial<Record<AssetClass, number>>),
    },
    per_symbol_limit_pct:
      r.per_symbol_limit_pct == null ? null : Number(r.per_symbol_limit_pct),
    stop_loss_pct: Number(r.stop_loss_pct ?? DEFAULTS.stop_loss_pct),
    take_profit_pct: Number(r.take_profit_pct ?? DEFAULTS.take_profit_pct),
    atr_trailing_mult: Number(r.atr_trailing_mult ?? DEFAULTS.atr_trailing_mult),
    max_hold_days: Number(r.max_hold_days ?? DEFAULTS.max_hold_days),
    volatility_sizing:
      typeof r.volatility_sizing === "boolean"
        ? r.volatility_sizing
        : DEFAULTS.volatility_sizing,
    vol_target_pct: Number(r.vol_target_pct ?? DEFAULTS.vol_target_pct),
    risk_level: lvl && lvl >= 1 && lvl <= 5 ? lvl : undefined,
  };
}


const CLASSES: { key: AssetClass; label: string }[] = [
  { key: "stock", label: "Stocks" },
  { key: "etf", label: "ETFs" },
  { key: "crypto", label: "Crypto" },
  { key: "commodity", label: "Commodities" },
  { key: "fx", label: "FX" },
];

// Simple 1..5 risk-level presets. Moving the slider rewrites every detailed
// field below so the two views stay in sync.
const RISK_PRESETS: Record<number, { name: string; blurb: string; cfg: RiskConfig }> = {
  1: {
    name: "Low risk",
    blurb: "Capital preservation. Tight stops, small positions, mostly ETFs.",
    cfg: {
      asset_class_limits: { stock: 0.3, etf: 0.9, crypto: 0.02, commodity: 0.15, fx: 0.15 },
      per_symbol_limit_pct: 0.05,
      stop_loss_pct: 0.05,
      take_profit_pct: 0.15,
      atr_trailing_mult: 2,
      max_hold_days: 60,
      volatility_sizing: true,
      vol_target_pct: 0.007,
    },
  },
  2: {
    name: "Cautious",
    blurb: "Slow and steady growth with limited crypto/commodity exposure.",
    cfg: {
      asset_class_limits: { stock: 0.5, etf: 0.85, crypto: 0.05, commodity: 0.2, fx: 0.2 },
      per_symbol_limit_pct: 0.08,
      stop_loss_pct: 0.07,
      take_profit_pct: 0.2,
      atr_trailing_mult: 2.5,
      max_hold_days: 90,
      volatility_sizing: true,
      vol_target_pct: 0.01,
    },
  },
  3: {
    name: "Balanced",
    blurb: "Default mix — moderate stops, diversified caps.",
    cfg: { ...DEFAULTS },
  },
  4: {
    name: "Growth",
    blurb: "Larger positions, wider stops, more crypto/commodity room.",
    cfg: {
      asset_class_limits: { stock: 0.75, etf: 0.75, crypto: 0.3, commodity: 0.4, fx: 0.4 },
      per_symbol_limit_pct: 0.2,
      stop_loss_pct: 0.15,
      take_profit_pct: 0.4,
      atr_trailing_mult: 4,
      max_hold_days: 0,
      volatility_sizing: true,
      vol_target_pct: 0.02,
    },
  },
  5: {
    name: "High risk",
    blurb: "Aggressive concentration, wide stops, run winners hard.",
    cfg: {
      asset_class_limits: { stock: 0.9, etf: 0.6, crypto: 0.5, commodity: 0.5, fx: 0.5 },
      per_symbol_limit_pct: 0.35,
      stop_loss_pct: 0.25,
      take_profit_pct: 0.75,
      atr_trailing_mult: 5,
      max_hold_days: 0,
      volatility_sizing: false,
      vol_target_pct: 0.03,
    },
  },
};

function inferRiskLevel(cfg: RiskConfig): number {
  // Match by nearest stop_loss + per_symbol_limit — good enough for slider sync.
  let best = 3;
  let bestDist = Infinity;
  for (const [lvl, p] of Object.entries(RISK_PRESETS)) {
    const d =
      Math.abs(p.cfg.stop_loss_pct - cfg.stop_loss_pct) +
      Math.abs((p.cfg.per_symbol_limit_pct ?? 0.15) - (cfg.per_symbol_limit_pct ?? 0.15)) +
      Math.abs(p.cfg.take_profit_pct - cfg.take_profit_pct) * 0.5;
    if (d < bestDist) {
      bestDist = d;
      best = Number(lvl);
    }
  }
  return best;
}

type FieldChange = { label: string; from: string; to: string };

const CLASS_LABEL: Record<AssetClass, string> = {
  stock: "Stocks cap",
  etf: "ETFs cap",
  crypto: "Crypto cap",
  commodity: "Commodities cap",
  fx: "FX cap",
};

const fmtPct = (v: number | null | undefined, digits = 0) =>
  v == null ? "default" : `${(v * 100).toFixed(digits)}%`;

function diffConfigs(prev: RiskConfig, next: RiskConfig): FieldChange[] {
  const out: FieldChange[] = [];
  const push = (label: string, from: string, to: string) => {
    if (from !== to) out.push({ label, from, to });
  };
  push("Max position size", fmtPct(prev.per_symbol_limit_pct), fmtPct(next.per_symbol_limit_pct));
  push("Stop-loss", fmtPct(prev.stop_loss_pct), fmtPct(next.stop_loss_pct));
  push("Take-profit", fmtPct(prev.take_profit_pct), fmtPct(next.take_profit_pct));
  push(
    "ATR trailing stop",
    prev.atr_trailing_mult ? `${prev.atr_trailing_mult}× ATR` : "off",
    next.atr_trailing_mult ? `${next.atr_trailing_mult}× ATR` : "off",
  );
  push(
    "Max holding period",
    prev.max_hold_days ? `${prev.max_hold_days}d` : "no limit",
    next.max_hold_days ? `${next.max_hold_days}d` : "no limit",
  );
  push(
    "Volatility sizing",
    prev.volatility_sizing ? `on (target ${fmtPct(prev.vol_target_pct, 2)}/day)` : "off",
    next.volatility_sizing ? `on (target ${fmtPct(next.vol_target_pct, 2)}/day)` : "off",
  );
  for (const c of CLASSES) {
    push(
      CLASS_LABEL[c.key],
      fmtPct(prev.asset_class_limits[c.key] ?? 0),
      fmtPct(next.asset_class_limits[c.key] ?? 0),
    );
  }
  return out;
}

export function RiskControlsCard({
  portfolioId,
  riskConfig,
}: {
  portfolioId: string;
  riskConfig: unknown;
}) {
  const initial = useMemo(() => parseCfg(riskConfig), [riskConfig]);
  const [cfg, setCfg] = useState<RiskConfig>(initial);
  const [level, setLevel] = useState<number>(
    () => initial.risk_level ?? inferRiskLevel(initial),
  );
  const [open, setOpen] = useState(true);
  const [lastChange, setLastChange] = useState<{
    fromName: string;
    toName: string;
    changes: FieldChange[];
  } | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const applyLevel = (lvl: number) => {
    const nextCfg: RiskConfig = {
      ...RISK_PRESETS[lvl].cfg,
      asset_class_limits: { ...RISK_PRESETS[lvl].cfg.asset_class_limits },
      risk_level: lvl,
    };
    const changes = diffConfigs(cfg, nextCfg);
    setLastChange({
      fromName: RISK_PRESETS[level].name,
      toName: RISK_PRESETS[lvl].name,
      changes,
    });
    setLevel(lvl);
    setCfg(nextCfg);
  };


  const qc = useQueryClient();
  const save = useServerFn(updateRiskConfig);
  const mut = useMutation({
    mutationFn: (payload: RiskConfig) =>
      save({
        data: {
          portfolio_id: portfolioId,
          risk_config: payload,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portfolio", portfolioId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Debounced auto-save: persist any change (slider or fine-tuning) so the
  // exact profile is restored on next open — no explicit Save needed.
  const isFirstRun = useRef(true);
  const savedSnapshotRef = useRef<string>(JSON.stringify({ ...initial, risk_level: level }));
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const payload: RiskConfig = { ...cfg, risk_level: level };
    const serialized = JSON.stringify(payload);
    if (serialized === savedSnapshotRef.current) return;
    setAutoSaveState("saving");
    const t = setTimeout(() => {
      mut.mutate(payload, {
        onSuccess: () => {
          savedSnapshotRef.current = serialized;
          setAutoSaveState("saved");
        },
        onError: () => setAutoSaveState("error"),
      });
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, level]);


  const pctInput = (
    label: string,
    hint: string,
    value: number,
    onChange: (v: number) => void,
    step = 1,
    max = 100,
  ) => (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="w-24"
          min={0}
          max={max}
          step={step}
          value={Number((value * 100).toFixed(2))}
          onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) || 0)) / 100)}
        />
        <span className="text-xs text-muted-foreground">% — {hint}</span>
      </div>
    </div>
  );

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full text-left">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" /> Risk controls
              </CardTitle>
              <CardDescription>
                Stop-loss {(cfg.stop_loss_pct * 100).toFixed(0)}% · Take-profit {(cfg.take_profit_pct * 100).toFixed(0)}% ·{" "}
                {cfg.atr_trailing_mult > 0 ? `trail ${cfg.atr_trailing_mult}×ATR · ` : ""}
                {cfg.max_hold_days > 0 ? `max-hold ${cfg.max_hold_days}d · ` : ""}
                {cfg.volatility_sizing ? `vol-target ${(cfg.vol_target_pct * 100).toFixed(2)}%/day` : "vol sizing off"}
              </CardDescription>
            </div>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-6">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="flex items-center gap-2 text-sm font-semibold">
                  <Gauge className="h-4 w-4 text-primary" /> Risk level
                </h4>
                <span className="text-sm font-medium text-primary">
                  {level}. {RISK_PRESETS[level].name}
                </span>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                {RISK_PRESETS[level].blurb} Moving the slider rewrites every detailed field
                below — fine-tune afterwards if you want.
              </p>
              <Slider
                min={1}
                max={5}
                step={1}
                value={[level]}
                onValueChange={(v) => applyLevel(v[0] ?? 3)}
              />
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>Low risk</span>
                <span>Cautious</span>
                <span>Balanced</span>
                <span>Growth</span>
                <span>High risk</span>
              </div>
              {lastChange && (
                <div className="mt-4 rounded-md border border-primary/30 bg-background/60 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">
                      Changes from{" "}
                      <span className="text-muted-foreground">{lastChange.fromName}</span> →{" "}
                      <span className="text-primary">{lastChange.toName}</span>
                    </p>
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => setLastChange(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                  {lastChange.changes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No parameters changed — your detailed settings already match this preset.
                    </p>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {lastChange.changes.map((c) => (
                        <li key={c.label} className="flex flex-wrap items-center gap-x-2">
                          <span className="font-medium">{c.label}:</span>
                          <span className="text-muted-foreground line-through">{c.from}</span>
                          <span aria-hidden>→</span>
                          <span className="tabular-nums text-primary">{c.to}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Save below to apply, or fine-tune any field manually.
                  </p>
                </div>
              )}
            </div>


            <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
              <h4 className="mb-1 text-sm font-semibold text-primary">Pre-trade enforcement</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                These limits are checked before every order. Buys exceeding the max position size are rejected; positions breaching the stop-loss or take-profit are auto-sold before the AI runs.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <Label className="text-xs font-medium"><Explain term="max_position">Max position size</Explain></Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={100}
                      step={1}
                      value={
                        cfg.per_symbol_limit_pct == null
                          ? ""
                          : Number((cfg.per_symbol_limit_pct * 100).toFixed(0))
                      }
                      placeholder="default"
                      onChange={(e) => {
                        const v = e.target.value;
                        setCfg((cur) => ({
                          ...cur,
                          per_symbol_limit_pct:
                            v === "" ? null : Math.max(0, Math.min(100, Number(v) || 0)) / 100,
                        }));
                      }}
                    />
                    <span className="text-xs text-muted-foreground">% per asset</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Blank = risk-level default (conservative 10%, balanced 15%, aggressive 25%).
                  </p>
                </div>
                <div>
                  <Label className="text-xs font-medium"><Explain term="stop_loss">Stop-loss</Explain></Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={90}
                      step={1}
                      value={Number((cfg.stop_loss_pct * 100).toFixed(2))}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          stop_loss_pct: Math.max(0, Math.min(90, Number(e.target.value) || 0)) / 100,
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">% drop → auto-sell</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">Set 0 to disable.</p>
                </div>
                <div>
                  <Label className="text-xs font-medium"><Explain term="take_profit">Take-profit</Explain></Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={500}
                      step={1}
                      value={Number((cfg.take_profit_pct * 100).toFixed(2))}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          take_profit_pct: Math.max(0, Math.min(500, Number(e.target.value) || 0)) / 100,
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">% gain → auto-sell</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">Set 0 to disable.</p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <Label className="text-xs font-medium"><Explain term="atr">ATR trailing stop</Explain></Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={10}
                      step={0.5}
                      value={cfg.atr_trailing_mult}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          atr_trailing_mult: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">× ATR below high-water mark → auto-sell</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Locks in gains as the price rises. Set 0 to disable. Typical: 2–3×.
                  </p>
                </div>
                <div>
                  <Label className="text-xs font-medium">Max holding period</Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={3650}
                      step={1}
                      value={cfg.max_hold_days}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          max_hold_days: Math.max(0, Math.min(3650, Math.floor(Number(e.target.value) || 0))),
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">days → time-based exit</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Force-close stale positions. Set 0 to disable.
                  </p>
                </div>
              </div>
            </div>


            <div>
              <h4 className="mb-2 text-sm font-medium">Per-asset-class limits</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Maximum share of portfolio value allowed in each asset class. Buys that would exceed the cap are rejected before execution.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {CLASSES.map((c) => (
                  <div key={c.key}>
                    <Label className="text-xs">{c.label}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        className="w-24"
                        min={0}
                        max={100}
                        step={5}
                        value={Number(((cfg.asset_class_limits[c.key] ?? 0) * 100).toFixed(0))}
                        onChange={(e) =>
                          setCfg((cur) => ({
                            ...cur,
                            asset_class_limits: {
                              ...cur.asset_class_limits,
                              [c.key]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100,
                            },
                          }))
                        }
                      />
                      <span className="text-xs text-muted-foreground">% of portfolio</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>


            <div>
              <h4 className="mb-2 text-sm font-medium"><Explain term="inverse_vol_sizing">Volatility-based sizing</Explain></h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Caps the size of each new buy so its 20-day volatility contributes roughly the target daily risk to the portfolio. Choppy assets get smaller positions.
              </p>
              <div className="flex items-center gap-3">
                <Switch
                  checked={cfg.volatility_sizing}
                  onCheckedChange={(v) => setCfg((c) => ({ ...c, volatility_sizing: v }))}
                />
                <span className="text-xs">Enabled</span>
              </div>
              {cfg.volatility_sizing && (
                <div className="mt-3">
                  {pctInput(
                    "Daily volatility target per position",
                    "e.g. 1.5% = position sized so a 1σ move ≈ 1.5% of portfolio",
                    cfg.vol_target_pct,
                    (v) => setCfg((c) => ({ ...c, vol_target_pct: v })),
                    0.1,
                    10,
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-border pt-4">
              <Button
                onClick={() => mut.mutate({ ...cfg, risk_level: level })}
                disabled={mut.isPending}
              >
                {mut.isPending ? "Saving…" : "Save now"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCfg({ ...DEFAULTS });
                  setLevel(3);
                }}
                disabled={mut.isPending}
              >
                Reset to defaults
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                {autoSaveState === "saving" && "Saving changes…"}
                {autoSaveState === "saved" && "Auto-saved — will be restored next time you open this portfolio."}
                {autoSaveState === "error" && (
                  <span className="text-destructive">Auto-save failed — click Save now.</span>
                )}
                {autoSaveState === "idle" && "Changes auto-save and persist across sessions."}
              </span>
            </div>

          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
