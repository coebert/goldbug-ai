// Trade-tab strategy builder: define entry / stop-loss / take-profit per
// symbol, arm them, and run the evaluator so triggered rules place real orders.
// Also hosts the per-position drawdown budget that auto-closes losers.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
import { POLL } from "@/lib/query-keys";
  listStrategies,
  saveStrategy,
  deleteStrategy,
  setConcentrationCap,
  setDrawdownBudget,
  runStrategies,
} from "@/lib/strategy.functions";

type Draft = {
  symbol: string;
  assetClass: "stock" | "etf" | "crypto" | "commodity" | "fx";
  instrumentCcy: string;
  quantity: string;
  entryPrice: string;
  entryMode: "limit" | "breakout" | "market";
  stopLoss: string;
  takeProfit: string;
};

const EMPTY: Draft = {
  symbol: "",
  assetClass: "etf",
  instrumentCcy: "GBP",
  quantity: "",
  entryPrice: "",
  entryMode: "limit",
  stopLoss: "",
  takeProfit: "",
};

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function StrategyBuilderCard({ portfolioId }: { portfolioId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listStrategies);
  const save = useServerFn(saveStrategy);
  const del = useServerFn(deleteStrategy);
  const setBudget = useServerFn(setDrawdownBudget);
  const setCap = useServerFn(setConcentrationCap);
  const run = useServerFn(runStrategies);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [budgetPct, setBudgetPct] = useState<string>("");
  const [autoClose, setAutoClose] = useState(false);
  const [touchedBudget, setTouchedBudget] = useState(false);
  const [capPct, setCapPct] = useState<string>("");
  const [autoTrim, setAutoTrim] = useState(false);
  const [touchedCap, setTouchedCap] = useState(false);

  const q = useQuery({
    queryKey: ["strategies", portfolioId],
    queryFn: async () => {
      const r = await list({ data: { portfolioId } });
      if (!touchedBudget) {
        setBudgetPct(r.ddBudgetPct != null ? String(r.ddBudgetPct) : "");
        setAutoClose(r.ddAutoClose);
      }
      if (!touchedCap) {
        setCapPct(r.concentrationCapPct != null ? String(r.concentrationCapPct) : "");
        setAutoTrim(r.concentrationAutoTrim);
      }
      return r;
    },
    refetchInterval: POLL.SEMI_LIVE,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["strategies", portfolioId] });
    void qc.invalidateQueries({ queryKey: qk.portfolio.detail(portfolioId) });
    void qc.invalidateQueries({ queryKey: ["order-fills", portfolioId] });
  };

  const saveM = useMutation({
    mutationFn: async () => {
      const quantity = num(draft.quantity);
      const entryPrice = num(draft.entryPrice);
      if (!draft.symbol.trim()) throw new Error("Enter a symbol.");
      if (!quantity) throw new Error("Enter a positive quantity.");
      if (!entryPrice) throw new Error("Enter a positive entry price.");
      return save({
        data: {
          portfolioId,
          symbol: draft.symbol,
          assetClass: draft.assetClass,
          instrumentCcy: draft.instrumentCcy,
          quantity,
          entryPrice,
          entryMode: draft.entryMode,
          stopLoss: num(draft.stopLoss),
          takeProfit: num(draft.takeProfit),
          enabled: true,
        },
      });
    },
    onSuccess: () => {
      toast.success("Strategy saved");
      setDraft(EMPTY);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runM = useMutation({
    mutationFn: () => run({ data: { portfolioId } }),
    onSuccess: (r) => {
      const acted = r.actions.filter((a) => a.action !== "none");
      toast.success(
        acted.length
          ? `${acted.length} order(s) placed: ${acted.map((a) => `${a.symbol} ${a.action}`).join(", ")}`
          : "No rules triggered",
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const capM = useMutation({
    mutationFn: () =>
      setCap({
        data: {
          portfolioId,
          capPct: num(capPct),
          autoTrim: autoTrim && num(capPct) != null,
        },
      }),
    onSuccess: () => {
      toast.success("Concentration cap saved");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const budgetM = useMutation({
    mutationFn: () =>
      setBudget({
        data: {
          portfolioId,
          budgetPct: num(budgetPct),
          autoClose: autoClose && num(budgetPct) != null,
        },
      }),
    onSuccess: () => {
      toast.success("Drawdown budget saved");
      setTouchedBudget(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = q.data?.strategies ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Strategy builder</CardTitle>
        <Button size="sm" onClick={() => runM.mutate()} disabled={runM.isPending}>
          <Play className="mr-1.5 h-3.5 w-3.5" />
          {runM.isPending ? "Running…" : "Run now"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          Rules are checked on the latest cached close. An armed rule buys when the entry
          triggers; an open rule sells the whole position when the stop-loss or take-profit is
          reached. Live portfolios route through the broker, simulations fill locally.
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          <div className="space-y-1">
            <Label htmlFor="sb-symbol" className="text-xs">Symbol</Label>
            <Input
              id="sb-symbol"
              value={draft.symbol}
              placeholder="ZETH.DE"
              onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Asset</Label>
            <Select
              value={draft.assetClass}
              onValueChange={(v) => setDraft({ ...draft, assetClass: v as Draft["assetClass"] })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["stock", "etf", "crypto", "commodity", "fx"].map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-ccy" className="text-xs">Currency</Label>
            <Input
              id="sb-ccy"
              value={draft.instrumentCcy}
              onChange={(e) => setDraft({ ...draft, instrumentCcy: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-qty" className="text-xs">Quantity</Label>
            <Input
              id="sb-qty"
              inputMode="decimal"
              value={draft.quantity}
              onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Entry type</Label>
            <Select
              value={draft.entryMode}
              onValueChange={(v) => setDraft({ ...draft, entryMode: v as Draft["entryMode"] })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="limit">Limit (at or below)</SelectItem>
                <SelectItem value="breakout">Breakout (at or above)</SelectItem>
                <SelectItem value="market">Market (next run)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-entry" className="text-xs">Entry price</Label>
            <Input
              id="sb-entry"
              inputMode="decimal"
              value={draft.entryPrice}
              onChange={(e) => setDraft({ ...draft, entryPrice: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-stop" className="text-xs">Stop-loss</Label>
            <Input
              id="sb-stop"
              inputMode="decimal"
              value={draft.stopLoss}
              onChange={(e) => setDraft({ ...draft, stopLoss: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sb-tp" className="text-xs">Take-profit</Label>
            <Input
              id="sb-tp"
              inputMode="decimal"
              value={draft.takeProfit}
              onChange={(e) => setDraft({ ...draft, takeProfit: e.target.value })}
            />
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => saveM.mutate()} disabled={saveM.isPending}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {saveM.isPending ? "Saving…" : "Add / update rule"}
        </Button>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 text-left">Symbol</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Entry</th>
                <th className="text-right">Stop</th>
                <th className="text-right">Target</th>
                <th className="text-left">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-muted-foreground">
                    No rules yet.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-2 font-medium">
                    {r.symbol}
                    <span className="ml-2 text-xs text-muted-foreground">{r.entry_mode}</span>
                  </td>
                  <td className="text-right tabular-nums">{Number(r.quantity)}</td>
                  <td className="text-right tabular-nums">{Number(r.entry_price)}</td>
                  <td className="text-right tabular-nums">
                    {r.stop_loss != null ? Number(r.stop_loss) : "—"}
                  </td>
                  <td className="text-right tabular-nums">
                    {r.take_profit != null ? Number(r.take_profit) : "—"}
                  </td>
                  <td>
                    <Badge variant={r.status === "error" ? "destructive" : "secondary"}>
                      {r.status}
                    </Badge>
                    {r.last_error && (
                      <span className="ml-2 text-xs text-destructive">{r.last_error}</span>
                    )}
                  </td>
                  <td className="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${r.symbol} rule`}
                      onClick={async () => {
                        await del({ data: { id: r.id } });
                        invalidate();
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-md border p-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="sb-budget" className="text-xs">
                Per-position drawdown budget (%)
              </Label>
              <Input
                id="sb-budget"
                className="w-32"
                inputMode="decimal"
                value={budgetPct}
                placeholder="e.g. 12"
                onChange={(e) => {
                  setTouchedBudget(true);
                  setBudgetPct(e.target.value);
                }}
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                id="sb-autoclose"
                checked={autoClose}
                onCheckedChange={(v) => {
                  setTouchedBudget(true);
                  setAutoClose(v);
                }}
              />
              <Label htmlFor="sb-autoclose" className="text-xs">Auto-close over-budget positions</Label>
            </div>
            <Button size="sm" variant="secondary" onClick={() => budgetM.mutate()} disabled={budgetM.isPending}>
              Save budget
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Any equity, ETF, commodity or crypto holding whose unrealised loss breaches the budget
            is closed in full on the next run — the same protection FX legs already have.
          </p>
        </div>

        <div className="rounded-md border p-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="sb-cap" className="text-xs">
                Max single-position weight (%)
              </Label>
              <Input
                id="sb-cap"
                className="w-32"
                inputMode="decimal"
                value={capPct}
                placeholder="e.g. 25"
                onChange={(e) => {
                  setTouchedCap(true);
                  setCapPct(e.target.value);
                }}
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                id="sb-autotrim"
                checked={autoTrim}
                onCheckedChange={(v) => {
                  setTouchedCap(true);
                  setAutoTrim(v);
                }}
              />
              <Label htmlFor="sb-autotrim" className="text-xs">
                Auto-trim over-concentrated positions
              </Label>
            </div>
            <Button size="sm" variant="secondary" onClick={() => capM.mutate()} disabled={capM.isPending}>
              Save cap
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Weight is measured against gross book value (positions + cash). Any holding above the
            cap is sold back down to it on the next run — this fires on winners too, so a single
            name can never quietly take over the portfolio.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
