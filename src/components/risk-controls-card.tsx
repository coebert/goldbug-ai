import { useMemo, useState } from "react";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import { ChevronDown, ShieldCheck } from "lucide-react";

type AssetClass = "stock" | "etf" | "crypto" | "commodity" | "fx";

type RiskConfig = {
  asset_class_limits: Partial<Record<AssetClass, number>>;
  per_symbol_limit_pct: number | null;
  stop_loss_pct: number;
  take_profit_pct: number;
  volatility_sizing: boolean;
  vol_target_pct: number;
};

const DEFAULTS: RiskConfig = {
  asset_class_limits: { stock: 0.6, etf: 0.8, crypto: 0.2, commodity: 0.3, fx: 0.3 },
  per_symbol_limit_pct: null,
  stop_loss_pct: 0.1,
  take_profit_pct: 0.25,
  volatility_sizing: true,
  vol_target_pct: 0.015,
};

function parseCfg(raw: unknown): RiskConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    asset_class_limits: {
      ...DEFAULTS.asset_class_limits,
      ...(r.asset_class_limits as Partial<Record<AssetClass, number>>),
    },
    per_symbol_limit_pct:
      r.per_symbol_limit_pct == null ? null : Number(r.per_symbol_limit_pct),
    stop_loss_pct: Number(r.stop_loss_pct ?? DEFAULTS.stop_loss_pct),
    take_profit_pct: Number(r.take_profit_pct ?? DEFAULTS.take_profit_pct),
    volatility_sizing:
      typeof r.volatility_sizing === "boolean"
        ? r.volatility_sizing
        : DEFAULTS.volatility_sizing,
    vol_target_pct: Number(r.vol_target_pct ?? DEFAULTS.vol_target_pct),
  };
}

const CLASSES: { key: AssetClass; label: string }[] = [
  { key: "stock", label: "Stocks" },
  { key: "etf", label: "ETFs" },
  { key: "crypto", label: "Crypto" },
  { key: "commodity", label: "Commodities" },
  { key: "fx", label: "FX" },
];

export function RiskControlsCard({
  portfolioId,
  riskConfig,
}: {
  portfolioId: string;
  riskConfig: unknown;
}) {
  const initial = useMemo(() => parseCfg(riskConfig), [riskConfig]);
  const [cfg, setCfg] = useState<RiskConfig>(initial);
  const [open, setOpen] = useState(false);

  const qc = useQueryClient();
  const save = useServerFn(updateRiskConfig);
  const mut = useMutation({
    mutationFn: () =>
      save({
        data: {
          portfolio_id: portfolioId,
          risk_config: cfg,
        },
      }),
    onSuccess: () => {
      toast.success("Risk controls saved");
      qc.invalidateQueries({ queryKey: ["portfolio", portfolioId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

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
            <div>
              <h4 className="mb-2 text-sm font-medium">Auto-liquidation</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Applied before the AI runs each day, based on % change from average cost. Set to 0 to disable.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {pctInput(
                  "Stop-loss",
                  "auto-sell if a position drops this much",
                  cfg.stop_loss_pct,
                  (v) => setCfg((c) => ({ ...c, stop_loss_pct: v })),
                  1,
                  90,
                )}
                {pctInput(
                  "Take-profit",
                  "auto-sell if a position rises this much",
                  cfg.take_profit_pct,
                  (v) => setCfg((c) => ({ ...c, take_profit_pct: v })),
                  1,
                  500,
                )}
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">Per-asset limits</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Maximum share of portfolio value in each asset class. Buys that would exceed the cap are rejected.
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
              <h4 className="mb-2 text-sm font-medium">Per-symbol override</h4>
              <p className="mb-3 text-xs text-muted-foreground">
                Overrides the risk-level default (conservative 10%, balanced 15%, aggressive 25%) for any single position. Leave blank to keep the default.
              </p>
              <div className="flex items-center gap-2">
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
                  placeholder="—"
                  onChange={(e) => {
                    const v = e.target.value;
                    setCfg((cur) => ({
                      ...cur,
                      per_symbol_limit_pct:
                        v === "" ? null : Math.max(0, Math.min(100, Number(v) || 0)) / 100,
                    }));
                  }}
                />
                <span className="text-xs text-muted-foreground">% max per single asset</span>
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium">Volatility-based sizing</h4>
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

            <div className="flex items-center gap-2 border-t border-border pt-4">
              <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
                {mut.isPending ? "Saving…" : "Save risk controls"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setCfg({ ...DEFAULTS })}
                disabled={mut.isPending}
              >
                Reset to defaults
              </Button>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
