// Phase D — user-initiated manual FX conversion between currencies in a
// portfolio's multi-currency wallet. Shown on the portfolio page for
// portfolios with fx_enabled=true. Uses "wallet" execution by default,
// with a "spot" toggle when the portfolio is configured for real
// broker-side FX (`fx_execution_mode='spot'`).

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowRightLeft, Loader2 } from "lucide-react";

import { convertPortfolioCash } from "@/lib/fx-convert.functions";
import { previewFxConversion } from "@/lib/fx-convert-preview.functions";
import { readWallet } from "@/lib/portfolio-wallet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { qk } from "@/lib/query-keys";

const SUPPORTED = ["GBP", "USD", "EUR", "CHF", "JPY", "CAD", "AUD"] as const;

interface Props {
  portfolio: {
    id: string;
    currency: string | null;
    current_cash: number | null;
    cash_by_ccy?: unknown;
    fx_enabled?: boolean | null;
    fx_execution_mode?: string | null;
  };
}

const fmt = (n: number, ccy?: string) =>
  `${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${ccy ? ` ${ccy}` : ""}`;
const signed = (n: number, ccy?: string) => `${n > 0 ? "+" : ""}${fmt(n, ccy)}`;

export function ManualFxConvertCard({ portfolio }: Props) {
  const qc = useQueryClient();
  const convert = useServerFn(convertPortfolioCash);
  const preview = useServerFn(previewFxConversion);

  const rawCashByCcy = portfolio.cash_by_ccy;
  const cashByCcy =
    rawCashByCcy && typeof rawCashByCcy === "object" && !Array.isArray(rawCashByCcy)
      ? (rawCashByCcy as Record<string, number>)
      : null;

  const wallet = useMemo(
    () =>
      readWallet({
        currency: portfolio.currency,
        current_cash: portfolio.current_cash,
        cash_by_ccy: cashByCcy,
      }),
    [portfolio.currency, portfolio.current_cash, cashByCcy],
  );

  const walletCurrencies = Object.keys(wallet).sort();
  const currencyOptions = Array.from(
    new Set<string>([...walletCurrencies, ...SUPPORTED]),
  );

  const [from, setFrom] = useState<string>(
    walletCurrencies[0] ?? (portfolio.currency ?? "GBP").toUpperCase(),
  );
  const [to, setTo] = useState<string>(() => {
    const base = (portfolio.currency ?? "GBP").toUpperCase();
    return SUPPORTED.find((c) => c !== from) ?? (base === "USD" ? "GBP" : "USD");
  });
  const [amount, setAmount] = useState<string>("");
  const [useSpot, setUseSpot] = useState(false);

  const spotAvailable =
    portfolio.fx_execution_mode === "spot" && portfolio.fx_enabled === true;
  const execution: "wallet" | "spot" = useSpot && spotAvailable ? "spot" : "wallet";

  // Debounce amount for preview requests.
  const [debouncedAmount, setDebouncedAmount] = useState(amount);
  useEffect(() => {
    const h = setTimeout(() => setDebouncedAmount(amount), 300);
    return () => clearTimeout(h);
  }, [amount]);

  const amt = Number(debouncedAmount);
  const previewEnabled =
    Number.isFinite(amt) && amt > 0 && from !== to && portfolio.fx_enabled === true;

  const previewQ = useQuery({
    queryKey: ["fx-convert-preview", portfolio.id, from, to, amt, execution],
    enabled: previewEnabled,
    staleTime: 15_000,
    queryFn: () =>
      preview({
        data: {
          portfolioId: portfolio.id,
          from,
          to,
          amountFrom: amt,
          execution,
        },
      }),
  });

  const m = useMutation({
    mutationFn: async () => {
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a positive amount");
      return await convert({
        data: {
          portfolioId: portfolio.id,
          from,
          to,
          amountFrom: amt,
          execution,
        },
      });
    },
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(`Conversion rejected: ${res.detail}`);
        return;
      }
      toast.success(
        `Converted ${res.amountFrom.toLocaleString("en-GB")} ${res.fromCcy} → ${res.amountTo.toLocaleString("en-GB")} ${res.toCcy} @ ${res.rate.toFixed(4)}`,
      );
      setAmount("");
      qc.invalidateQueries({ queryKey: qk.portfolio.detail(portfolio.id) });
      qc.invalidateQueries({ queryKey: qk.portfolios.all() });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Conversion failed");
    },
  });

  if (portfolio.fx_enabled !== true) return null;

  const available = wallet[from] ?? 0;
  const swap = () => {
    setFrom(to);
    setTo(from);
  };

  const previewData = previewQ.data;
  type PreviewOk = {
    ok: true;
    fromCcy: string;
    toCcy: string;
    amountFrom: number;
    amountTo: number;
    midRate: number;
    effectiveRate: number;
    spreadBps: number;
    feeFrom: number;
    feeCcy: string;
    rateSource: string;
    rateStale: boolean;
    baseCcy: string;
    baseCcyDelta: number | null;
    newWallet: Record<string, number>;
    execution: "wallet" | "spot";
  };
  const previewOk: PreviewOk | null =
    previewData && previewData.ok === true ? (previewData as PreviewOk) : null;
  const previewErr =
    previewData && previewData.ok === false
      ? (previewData as { ok: false; reason: string; detail: string })
      : null;



  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowRightLeft className="h-4 w-4" />
          Convert cash between currencies
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-3 items-end">
          <div className="space-y-1">
            <Label>From</Label>
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {currencyOptions.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c} — {(wallet[c] ?? 0).toLocaleString("en-GB", { maximumFractionDigits: 2 })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={swap}
            aria-label="Swap currencies"
            className="self-end"
          >
            <ArrowRightLeft className="h-4 w-4" />
          </Button>
          <div className="space-y-1">
            <Label>To</Label>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {currencyOptions.filter((c) => c !== from).map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="fx-amount">Amount ({from})</Label>
          <Input
            id="fx-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Available: {available.toLocaleString("en-GB", { maximumFractionDigits: 2 })} {from}
          </p>
        </div>

        {spotAvailable && (
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="pr-3">
              <div className="text-sm font-medium">Execute as broker spot FX</div>
              <div className="text-xs text-muted-foreground">
                Places a real FX spot order with the broker instead of updating the
                wallet at our own quoted rate.
              </div>
            </div>
            <Switch checked={useSpot} onCheckedChange={setUseSpot} />
          </div>
        )}

        {previewEnabled && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <div className="font-medium">Conversion preview</div>
              {previewQ.isFetching && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
            </div>

            {previewErr && (
              <div className="text-destructive text-xs">
                {previewErr.reason}: {previewErr.detail}
              </div>
            )}

            {previewOk && (
              <>
                <div className="grid grid-cols-2 gap-y-1 gap-x-4 text-xs">
                  <span className="text-muted-foreground">Mid-market rate</span>
                  <span className="text-right tabular-nums">
                    {previewOk.midRate.toFixed(6)} {previewOk.toCcy}/{previewOk.fromCcy}
                  </span>

                  <span className="text-muted-foreground">
                    Effective rate ({previewOk.spreadBps} bps {previewOk.execution === "spot" ? "spot" : "wallet"} spread)
                  </span>
                  <span className="text-right tabular-nums">
                    {previewOk.effectiveRate.toFixed(6)}
                  </span>

                  <span className="text-muted-foreground">Estimated fee</span>
                  <span className="text-right tabular-nums">
                    {fmt(previewOk.feeFrom, previewOk.feeCcy)}
                  </span>

                  <span className="text-muted-foreground">You send</span>
                  <span className="text-right tabular-nums">
                    −{fmt(previewOk.amountFrom, previewOk.fromCcy)}
                  </span>

                  <span className="text-muted-foreground">You receive</span>
                  <span className="text-right tabular-nums font-medium">
                    +{fmt(previewOk.amountTo, previewOk.toCcy)}
                  </span>

                  {previewOk.baseCcyDelta !== null && previewOk.baseCcy !== previewOk.fromCcy && (
                    <>
                      <span className="text-muted-foreground">
                        Change in base ({previewOk.baseCcy})
                      </span>
                      <span
                        className={`text-right tabular-nums ${
                          previewOk.baseCcyDelta < 0 ? "text-destructive" : "text-emerald-600"
                        }`}
                      >
                        {signed(previewOk.baseCcyDelta, previewOk.baseCcy)}
                      </span>
                    </>
                  )}
                </div>

                <div className="pt-2 border-t">
                  <div className="text-xs font-medium mb-1">Post-conversion available cash</div>
                  <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5 text-xs tabular-nums">
                    {Object.keys(previewOk.newWallet)
                      .sort()
                      .map((ccy) => {
                        const before = wallet[ccy] ?? 0;
                        const after = previewOk.newWallet[ccy] ?? 0;
                        const delta = after - before;
                        return (
                          <div key={ccy} className="contents">
                            <span className="text-muted-foreground">{ccy}</span>
                            <span className="text-right">{fmt(after)}</span>
                            <span
                              className={
                                Math.abs(delta) < 0.005
                                  ? "text-muted-foreground text-right"
                                  : delta > 0
                                    ? "text-emerald-600 text-right"
                                    : "text-destructive text-right"
                              }
                            >
                              {Math.abs(delta) < 0.005 ? "—" : signed(delta)}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>

                {previewOk.rateStale && (
                  <div className="text-xs text-amber-600">
                    Rate is stale (source: {previewOk.rateSource}) — actual fill may differ.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <Button
          type="button"
          disabled={m.isPending || from === to || !amount || (previewEnabled && !previewOk)}
          onClick={() => m.mutate()}
          className="w-full"
        >
          {m.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Converting…
            </>
          ) : (
            <>Convert {from} → {to}</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
