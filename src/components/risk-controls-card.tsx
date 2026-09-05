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

import { COMMODITY_GROUPS, type CommodityGroup } from "@/lib/commodity-groups";

import {
  RISK_PRESETS,
  RISK_DIAL_DEFAULTS,
  SWING_DIAL_OVERRIDES,
  type RiskDialConfig,
  type DialAssetClass,
} from "@/lib/risk-presets";
import {
  AGGRESSIVENESS_BOUNDS,
  SIZE_MULT_BOUNDS,
  clampRange,
  resolveAggressiveness,
} from "@/lib/risk-aggressiveness";
import { qk } from "@/lib/query-keys";
import { TradingModeDriftNotice } from "@/components/trading-mode-drift-notice";
import { TradingModeBadge } from "@/components/trading-mode-badge";
import { writeCachedTradingMode } from "@/lib/trading-mode-store";
import { SHORT_PROXIES } from "@/lib/short-sleeve";

// The dial config lives in `@/lib/risk-presets` so the server-side sweep and
// the live engine read exactly the same table this card writes.
type AssetClass = DialAssetClass;
type RiskConfig = RiskDialConfig;

// Currencies the app can settle in today. Base currency is filtered out in the
// UI since caps only apply to non-base holdings.
const FX_CCY_OPTIONS: { code: string; label: string }[] = [
  { code: "USD", label: "US Dollar" },
  { code: "EUR", label: "Euro" },
  { code: "GBP", label: "Pound sterling" },
  { code: "JPY", label: "Japanese yen" },
  { code: "AUD", label: "Australian dollar" },
  { code: "CAD", label: "Canadian dollar" },
  { code: "CHF", label: "Swiss franc" },
];

const DEFAULTS: RiskConfig = RISK_DIAL_DEFAULTS;


function parseCfg(raw: unknown): RiskConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const lvl = r.risk_level == null ? undefined : Number(r.risk_level);
  const rawGroups = (r.commodity_group_limits ?? {}) as Record<string, unknown>;
  const groups: Partial<Record<CommodityGroup, number>> = {};
  for (const g of COMMODITY_GROUPS) {
    const v = rawGroups[g];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) groups[g] = Math.max(0, Math.min(1, n));
  }
  const bool = (k: string, d: boolean) => (typeof r[k] === "boolean" ? (r[k] as boolean) : d);
  const num = (k: string, d: number, min: number, max: number) => {
    const n = Number(r[k]);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
  };
  return {
    // Volatility-adjusted exits — clamped on read so a stored value can never
    // widen risk past the hard bounds the engine enforces.
    atr_scaled_stop_enabled: bool("atr_scaled_stop_enabled", DEFAULTS.atr_scaled_stop_enabled),
    initial_stop_atr_mult: num("initial_stop_atr_mult", DEFAULTS.initial_stop_atr_mult, 0.25, 10),
    atr_scaled_stop_floor_pct: num("atr_scaled_stop_floor_pct", DEFAULTS.atr_scaled_stop_floor_pct, 0, 0.5),
    take_profit_enabled: bool("take_profit_enabled", DEFAULTS.take_profit_enabled),
    atr_take_profit_enabled: bool("atr_take_profit_enabled", DEFAULTS.atr_take_profit_enabled),
    take_profit_atr_mult: num("take_profit_atr_mult", DEFAULTS.take_profit_atr_mult, 0, 20),
    atr_take_profit_floor_pct: num("atr_take_profit_floor_pct", DEFAULTS.atr_take_profit_floor_pct, 0, 2),
    atr_take_profit_cap_pct: num("atr_take_profit_cap_pct", DEFAULTS.atr_take_profit_cap_pct, 0, 5),
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
    max_daily_loss_pct: Number(r.max_daily_loss_pct ?? DEFAULTS.max_daily_loss_pct),
    max_drawdown_halt_pct: Number(r.max_drawdown_halt_pct ?? DEFAULTS.max_drawdown_halt_pct),
    commodity_group_limits: Object.keys(groups).length ? groups : { ...DEFAULTS.commodity_group_limits },
    commodity_min_adv_usd: Number.isFinite(Number(r.commodity_min_adv_usd))
      ? Number(r.commodity_min_adv_usd)
      : DEFAULTS.commodity_min_adv_usd,
    commodity_max_atr_pct: Number.isFinite(Number(r.commodity_max_atr_pct))
      ? Number(r.commodity_max_atr_pct)
      : DEFAULTS.commodity_max_atr_pct,
    fx_currency_limits: (() => {
      const src = (r.fx_currency_limits ?? {}) as Record<string, unknown>;
      const out: Partial<Record<string, number>> = {};
      for (const [k, v] of Object.entries(src)) {
        const code = String(k || "").toUpperCase().trim();
        if (!/^[A-Z]{3}$/.test(code)) continue;
        if (v == null || v === "") continue;
        const n = Number(v);
        if (Number.isFinite(n)) out[code] = Math.max(0, Math.min(1, n));
      }
      return out;
    })(),
    risk_level: lvl && lvl >= 1 && lvl <= 5 ? lvl : undefined,
    // Sizing / aggressiveness knobs — clamped on read so a bad stored value
    // can never widen risk beyond the hard bounds.
    size_multiplier: clampRange(
      r.size_multiplier,
      SIZE_MULT_BOUNDS.min,
      SIZE_MULT_BOUNDS.max,
      resolveAggressiveness(r).sizeMult,
    ),
    buy_aggressiveness: clampRange(
      r.buy_aggressiveness,
      AGGRESSIVENESS_BOUNDS.min,
      AGGRESSIVENESS_BOUNDS.max,
      resolveAggressiveness(r).buy,
    ),
    sell_aggressiveness: clampRange(
      r.sell_aggressiveness,
      AGGRESSIVENESS_BOUNDS.min,
      AGGRESSIVENESS_BOUNDS.max,
      resolveAggressiveness(r).sell,
    ),
    diversification_tilt:
      r.diversification_tilt === "balanced" || r.diversification_tilt === "strong"
        ? r.diversification_tilt
        : "off",
    stamp_exempt_preference:
      r.stamp_exempt_preference === "off" || r.stamp_exempt_preference === "strong"
        ? r.stamp_exempt_preference
        : "balanced",
    shorts_enabled: bool("shorts_enabled", DEFAULTS.shorts_enabled),
    short_sleeve_max_pct: num(
      "short_sleeve_max_pct",
      DEFAULTS.short_sleeve_max_pct,
      0,
      1,
    ),
    trading_style: r.trading_style === "swing" ? "swing" : "position",
    swing_min_hold_days: Number.isFinite(Number(r.swing_min_hold_days))
      ? Math.max(0, Math.min(30, Math.floor(Number(r.swing_min_hold_days))))
      : 2,
  };
}



const CLASSES: { key: AssetClass; label: string }[] = [
  { key: "stock", label: "Stocks" },
  { key: "etf", label: "ETFs" },
  { key: "crypto", label: "Crypto" },
  { key: "commodity", label: "Commodities" },
  { key: "fx", label: "FX" },
];

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
  push("Diversification tilt", prev.diversification_tilt ?? "off", next.diversification_tilt ?? "off");
  push(
    "Stamp-exempt preference",
    prev.stamp_exempt_preference ?? "balanced",
    next.stamp_exempt_preference ?? "balanced",
  );
  push(
    "Short selling",
    prev.shorts_enabled ? `on (${fmtPct(prev.short_sleeve_max_pct)} sleeve cap)` : "off",
    next.shorts_enabled ? `on (${fmtPct(next.short_sleeve_max_pct)} sleeve cap)` : "off",
  );
  push(
    "Trading style",
    prev.trading_style === "swing" ? "Swing (days–weeks)" : "Position (months)",
    next.trading_style === "swing" ? "Swing (days–weeks)" : "Position (months)",
  );
  push(
    "Swing min hold",
    `${prev.swing_min_hold_days ?? 2}d`,
    `${next.swing_min_hold_days ?? 2}d`,
  );
  return out;
}

export function RiskControlsCard({
  portfolioId,
  riskConfig,
  baseCurrency,
}: {
  portfolioId: string;
  riskConfig: unknown;
  baseCurrency?: string;
}) {
  const base = (baseCurrency ?? "GBP").toUpperCase();
  const fxOptions = FX_CCY_OPTIONS.filter((o) => o.code !== base);

  const initial = useMemo(() => parseCfg(riskConfig), [riskConfig]);
  const [cfg, setCfg] = useState<RiskConfig>(initial);
  const [level, setLevel] = useState<number>(
    () => initial.risk_level ?? inferRiskLevel(initial),
  );
  const [open, setOpen] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lastChange, setLastChange] = useState<{
    fromName: string;
    toName: string;
    changes: FieldChange[];
  } | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Mirror the style when it is flipped elsewhere (e.g. the always-visible
  // swing switch) so this card never re-saves a stale horizon.
  const serverStyle = initial.trading_style ?? "position";
  useEffect(() => {
    setCfg((c) =>
      (c.trading_style ?? "position") === serverStyle
        ? c
        : serverStyle === "swing"
          ? { ...c, ...SWING_DIAL_OVERRIDES, trading_style: "swing" }
          : { ...c, trading_style: "position" },
    );
  }, [serverStyle]);

  const applyLevel = (lvl: number) => {
    const style = cfg.trading_style ?? "position";
    const nextCfg: RiskConfig = {
      ...RISK_PRESETS[lvl].cfg,
      asset_class_limits: { ...RISK_PRESETS[lvl].cfg.asset_class_limits },
      risk_level: lvl,
      // The dial changes how much risk is taken, not the holding horizon.
      trading_style: style,
      ...(style === "swing"
        ? { ...SWING_DIAL_OVERRIDES, swing_min_hold_days: cfg.swing_min_hold_days ?? 2 }
        : {}),
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
    onSuccess: (_r, payload) => {
      // Mirror the saved horizon locally so the badge survives a refresh.
      writeCachedTradingMode(portfolioId, payload.trading_style === "swing" ? "swing" : "position");
      qc.invalidateQueries({ queryKey: qk.portfolio.detail(portfolioId) });
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
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div className="min-w-0">
              <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
                <span className="flex min-w-0 items-center gap-2">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate">Risk controls</span>
                </span>
                <TradingModeBadge
                  portfolioId={portfolioId}
                  riskConfig={{ trading_style: cfg.trading_style ?? "position" }}
                />
              </CardTitle>

              <CardDescription>
                {(cfg.trading_style ?? "position") === "swing"
                  ? "Swing horizon (days–weeks) · "
                  : "Position horizon (months) · "}
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
        {/* Outside the trigger: it has its own dismiss button. */}
        <TradingModeDriftNotice
          portfolioId={portfolioId}
          riskConfig={{ trading_style: initial.trading_style ?? "position" }}
          className="mx-6 mb-4"
        />

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

              {/* Sizing and per-side aggressiveness. The preset sets these,
                  but they can be fine-tuned without moving the whole dial. */}
              <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
                <p className="flex items-center gap-2 text-xs font-semibold">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-primary" /> Sizing &
                  aggressiveness
                </p>
                {(
                  [
                    {
                      key: "size_multiplier" as const,
                      label: "Position size",
                      hint: "Scales every buy budget and the per-symbol cap.",
                      bounds: SIZE_MULT_BOUNDS,
                    },
                    {
                      key: "buy_aggressiveness" as const,
                      label: "Buy aggressiveness",
                      hint: "How much of a wanted buy is taken in one go.",
                      bounds: AGGRESSIVENESS_BOUNDS,
                    },
                    {
                      key: "sell_aggressiveness" as const,
                      label: "Sell aggressiveness",
                      hint: "How fast trims and exits are completed.",
                      bounds: AGGRESSIVENESS_BOUNDS,
                    },
                  ]
                ).map((row) => {
                  const value = clampRange(
                    cfg[row.key],
                    row.bounds.min,
                    row.bounds.max,
                    1,
                  );
                  return (
                    <div key={row.key} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <Label className="text-xs">{row.label}</Label>
                        <span className="font-medium text-primary">{value.toFixed(2)}×</span>
                      </div>
                      <Slider
                        min={row.bounds.min}
                        max={row.bounds.max}
                        step={0.05}
                        value={[value]}
                        onValueChange={(v) =>
                          setCfg((c) => ({ ...c, [row.key]: v[0] ?? value }))
                        }
                      />
                      <p className="text-[11px] text-muted-foreground">{row.hint}</p>
                    </div>
                  );
                })}
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


            <div className="flex items-center justify-between rounded-md border border-border bg-background/40 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Fine-tune individual limits</span>
                <span className="hidden sm:inline text-xs text-muted-foreground">
                  (stops, caps, sizing)
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant={showAdvanced ? "secondary" : "outline"}
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
              >
                {showAdvanced ? "Hide advanced" : "Show advanced"}
              </Button>
            </div>

            {showAdvanced && (
            <>
            <div className="rounded-md border border-border bg-background/40 p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h4 className="text-sm font-semibold">Short selling</h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Bearish positions use cash-funded inverse UCITS ETFs ({SHORT_PROXIES.map((p) => p.symbol).join(" / ")}). No borrowing, margin, CFDs, options, or naked stock shorts.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="shorts-enabled" className="text-xs font-medium">
                    Short sleeve
                  </Label>
                  <Switch
                    id="shorts-enabled"
                    checked={cfg.shorts_enabled}
                    onCheckedChange={(v) => setCfg((c) => ({ ...c, shorts_enabled: v }))}
                  />
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr] sm:items-end">
                <div>
                  <Label className="text-xs font-medium">Max short sleeve</Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={100}
                      step={5}
                      disabled={!cfg.shorts_enabled}
                      value={Number((cfg.short_sleeve_max_pct * 100).toFixed(0))}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          short_sleeve_max_pct:
                            Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100,
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">% of portfolio value</span>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Inverse ETFs reset daily, so the engine treats them as tactical and reviews them frequently. Total long plus short exposure can never exceed 100% of portfolio value.
                </p>
              </div>
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
              <h4 className="mb-2 text-sm font-medium">Hard halts</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Circuit-breakers that block <strong>all new buys</strong> when the portfolio has already lost too much
                today, or is too far below its all-time peak. Automatic stop-loss / take-profit sells still fire so the
                portfolio can de-risk. Set 0 to disable either halt.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs font-medium">Max daily loss</Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={90}
                      step={0.5}
                      value={Number((cfg.max_daily_loss_pct * 100).toFixed(2))}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          max_daily_loss_pct: Math.max(0, Math.min(0.9, Number(e.target.value) / 100 || 0)),
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">% vs yesterday → pause buys</span>
                  </div>
                </div>
                <div>
                  <Label className="text-xs font-medium">Max drawdown halt</Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={90}
                      step={0.5}
                      value={Number((cfg.max_drawdown_halt_pct * 100).toFixed(2))}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          max_drawdown_halt_pct: Math.max(0, Math.min(0.9, Number(e.target.value) / 100 || 0)),
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">% from peak → pause buys</span>
                  </div>
                </div>
              </div>
            </div>


            <div>
              <h4 className="mb-2 text-sm font-medium">Trading style</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Sets the holding horizon the AI trades to. Swing rebases stops,
                targets, time exits and re-entry rules for a days-to-weeks hold.
              </p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    {
                      key: "position",
                      label: "Position",
                      blurb: "Months-long holds. Wider stops, slower turnover.",
                    },
                    {
                      key: "swing",
                      label: "Swing",
                      blurb: "Days-to-weeks holds. Tight 6% stop, 12% target, 10-day time stop, fast re-entry.",
                    },
                  ] as const
                ).map((opt) => {
                  const active = (cfg.trading_style ?? "position") === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() =>
                        setCfg((c) =>
                          opt.key === "swing"
                            ? { ...c, ...SWING_DIAL_OVERRIDES, trading_style: "swing" }
                            : { ...c, trading_style: "position" },
                        )
                      }
                      className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                    >
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-muted-foreground">{opt.blurb}</div>
                    </button>
                  );
                })}
              </div>
              {(cfg.trading_style ?? "position") === "swing" && (
                <div className="mt-3 flex items-center gap-2">
                  <Label className="text-xs">Minimum hold (sessions)</Label>
                  <Input
                    type="number"
                    className="h-8 w-20"
                    value={cfg.swing_min_hold_days ?? 2}
                    onChange={(e) =>
                      setCfg((c) => ({
                        ...c,
                        swing_min_hold_days: Math.max(0, Math.min(30, Math.floor(Number(e.target.value) || 0))),
                      }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    blocks discretionary exits before this age — risk exits still fire
                  </span>
                </div>
              )}
            </div>


            <div>
              <h4 className="mb-2 text-sm font-medium">Diversification tilt</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Nudges the AI toward commodities and FX <em>on top of</em> the
                baseline risk-and-regime ranking. Purely a soft bias — hard
                asset-class caps above still apply.
              </p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { key: "off", label: "Off", blurb: "Neutral — rank by risk and regime only." },
                    { key: "balanced", label: "Balanced", blurb: "Prefer a commodity/FX add over doubling up when the setup is there." },
                    { key: "strong", label: "Strong", blurb: "Actively hunt for the best commodity/FX ideas each cycle." },
                  ] as const
                ).map((opt) => {
                  const active = (cfg.diversification_tilt ?? "off") === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setCfg((c) => ({ ...c, diversification_tilt: opt.key }))}
                      className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                    >
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-muted-foreground">{opt.blurb}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">Stamp-exempt preference</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                UK single shares pay 0.5% stamp duty on every buy — 50bps the
                position must earn back before it makes anything. ETFs, ETCs and
                non-UK listings are exempt. When two ideas look about as strong,
                this prefers the exempt one to lower the required break-even.
              </p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    { key: "off", label: "Off", blurb: "Rank on modelled costs only." },
                    { key: "balanced", label: "Balanced", blurb: "Break near-ties in favour of stamp-exempt instruments." },
                    { key: "strong", label: "Strong", blurb: "Weigh stamp duty double when ranking UK single stocks." },
                  ] as const
                ).map((opt) => {
                  const active = (cfg.stamp_exempt_preference ?? "balanced") === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setCfg((c) => ({ ...c, stamp_exempt_preference: opt.key }))}
                      className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                    >
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-muted-foreground">{opt.blurb}</div>
                    </button>
                  );
                })}
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
              <h4 className="mb-2 text-sm font-medium">Commodity sub-limits</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Fine-grained caps on top of the overall <em>Commodities</em> asset-class limit above. Blank = no per-group cap for that bucket.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {COMMODITY_GROUPS.map((g) => {
                  const v = cfg.commodity_group_limits[g];
                  return (
                    <div key={g}>
                      <Label className="text-xs">Max {g} %</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          className="w-24"
                          min={0}
                          max={100}
                          step={1}
                          placeholder="—"
                          value={v == null ? "" : Number((v * 100).toFixed(0))}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setCfg((cur) => {
                              const next = { ...cur.commodity_group_limits };
                              if (raw === "") delete next[g];
                              else next[g] = Math.max(0, Math.min(100, Number(raw) || 0)) / 100;
                              return { ...cur, commodity_group_limits: next };
                            });
                          }}
                        />
                        <span className="text-xs text-muted-foreground">% of NAV</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <Label className="text-xs font-medium">Min 20-day average daily $ volume</Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-32"
                      min={0}
                      max={1_000_000_000}
                      step={10_000}
                      value={cfg.commodity_min_adv_usd}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          commodity_min_adv_usd: Math.max(0, Math.min(1e9, Number(e.target.value) || 0)),
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">$ — reject illiquid commodity ETC/ETFs (0 disables)</span>
                  </div>
                </div>
                <div>
                  <Label className="text-xs font-medium">Max 14-day ATR (spread proxy)</Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={100}
                      step={0.5}
                      value={Number((cfg.commodity_max_atr_pct * 100).toFixed(2))}
                      onChange={(e) =>
                        setCfg((c) => ({
                          ...c,
                          commodity_max_atr_pct: Math.max(0, Math.min(1, (Number(e.target.value) || 0) / 100)),
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">% — block choppy/thin commodities (0 disables)</span>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">Per-currency exposure caps</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Caps the base-currency value of holdings priced in each non-base currency. Buys that would breach a cap are shrunk or rejected — no borrowing is used. Portfolio base: <span className="font-medium">{base}</span>. Leave blank to disable a cap.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {fxOptions.map((opt) => {
                  const raw = cfg.fx_currency_limits?.[opt.code];
                  const value = raw == null ? "" : String(Math.round(raw * 100));
                  return (
                    <div key={opt.code} className="flex items-center gap-2">
                      <label className="w-28 text-xs" htmlFor={`fxcap-${opt.code}`}>
                        {opt.code} · {opt.label}
                      </label>
                      <Input
                        id={`fxcap-${opt.code}`}
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        placeholder="—"
                        value={value}
                        onChange={(e) => {
                          const next = { ...(cfg.fx_currency_limits ?? {}) };
                          const v = e.target.value.trim();
                          if (v === "") {
                            delete next[opt.code];
                          } else {
                            const n = Number(v);
                            if (Number.isFinite(n)) next[opt.code] = Math.max(0, Math.min(1, n / 100));
                          }
                          setCfg({ ...cfg, fx_currency_limits: next });
                        }}
                        className="h-8 w-24"
                      />
                      <span className="text-xs text-muted-foreground">% of NAV</span>
                    </div>
                  );
                })}
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

            <div>
              <h4 className="mb-2 text-sm font-medium">Volatility-adjusted exits</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Stops and profit targets are measured in ATR (average daily range) rather than
                a flat percentage, so a calm mega-cap and a jumpy miner get exits that mean the
                same thing in risk terms. The hard stop can only ever be tightened by this,
                never widened.
              </p>
              <div className="flex items-center gap-3">
                <Switch
                  checked={cfg.atr_scaled_stop_enabled}
                  onCheckedChange={(v) => setCfg((c) => ({ ...c, atr_scaled_stop_enabled: v }))}
                />
                <span className="text-xs">
                  ATR-scaled stop-loss ({cfg.initial_stop_atr_mult}× ATR, floor{" "}
                  {(cfg.atr_scaled_stop_floor_pct * 100).toFixed(1)}%, capped at the{" "}
                  {(cfg.stop_loss_pct * 100).toFixed(0)}% hard stop)
                </span>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Switch
                  checked={cfg.take_profit_enabled}
                  onCheckedChange={(v) => setCfg((c) => ({ ...c, take_profit_enabled: v }))}
                />
                <span className="text-xs">
                  Take-profit {cfg.take_profit_enabled ? "armed" : "off — winners run until a stop, trail or time exit"}
                </span>
              </div>
              {cfg.take_profit_enabled && (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={cfg.atr_take_profit_enabled}
                      onCheckedChange={(v) => setCfg((c) => ({ ...c, atr_take_profit_enabled: v }))}
                    />
                    <span className="text-xs">
                      Size the target in ATR ({cfg.take_profit_atr_mult}× ATR) instead of a flat{" "}
                      {(cfg.take_profit_pct * 100).toFixed(0)}%
                    </span>
                  </div>
                  {cfg.atr_take_profit_enabled && (
                    <>
                      <div>
                        <Label className="text-xs">Profit target, in ATRs</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            className="w-24"
                            min={0}
                            max={20}
                            step={0.5}
                            value={cfg.take_profit_atr_mult}
                            onChange={(e) =>
                              setCfg((c) => ({
                                ...c,
                                take_profit_atr_mult: Math.max(0, Math.min(20, Number(e.target.value) || 0)),
                              }))
                            }
                          />
                          <span className="text-xs text-muted-foreground">
                            × ATR — e.g. 4 = exit when the gain reaches four average daily ranges
                          </span>
                        </div>
                      </div>
                      {pctInput(
                        "Smallest allowed target",
                        "Keeps quiet names from taking profit inside daily noise",
                        cfg.atr_take_profit_floor_pct,
                        (v) => setCfg((c) => ({ ...c, atr_take_profit_floor_pct: v })),
                        0.5,
                        100,
                      )}
                      {pctInput(
                        "Largest allowed target",
                        "Keeps volatile names from aiming at a gain that never arrives",
                        cfg.atr_take_profit_cap_pct,
                        (v) => setCfg((c) => ({ ...c, atr_take_profit_cap_pct: v })),
                        1,
                        200,
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
            </>
            )}


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
