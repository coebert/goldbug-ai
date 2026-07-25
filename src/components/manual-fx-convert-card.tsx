// Phase D — user-initiated manual FX conversion between currencies in a
// portfolio's multi-currency wallet. Shown on the portfolio page for
// portfolios with fx_enabled=true. Uses "wallet" execution by default,
// with a "spot" toggle when the portfolio is configured for real
// broker-side FX (`fx_execution_mode='spot'`).

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowRightLeft, Loader2 } from "lucide-react";

import { convertPortfolioCash } from "@/lib/fx-convert.functions";
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

const SUPPORTED = ["GBP", "USD", "EUR", "CHF", "JPY", "CAD", "AUD"] as const;

interface Props {
  portfolio: {
    id: string;
    currency: string | null;
    current_cash: number | null;
    cash_by_ccy?: Record<string, number> | null;
    fx_enabled?: boolean | null;
    fx_execution_mode?: string | null;
  };
}

export function ManualFxConvertCard({ portfolio }: Props) {
  const qc = useQueryClient();
  const convert = useServerFn(convertPortfolioCash);

  const wallet = useMemo(
    () =>
      readWallet({
        currency: portfolio.currency,
        current_cash: portfolio.current_cash,
        cash_by_ccy: portfolio.cash_by_ccy ?? null,
      }),
    [portfolio.currency, portfolio.current_cash, portfolio.cash_by_ccy],
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

  const m = useMutation({
    mutationFn: async () => {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a positive amount");
      return await convert({
        data: {
          portfolioId: portfolio.id,
          from,
          to,
          amountFrom: amt,
          execution: useSpot && spotAvailable ? "spot" : "wallet",
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
      qc.invalidateQueries({ queryKey: ["portfolio", portfolio.id] });
      qc.invalidateQueries({ queryKey: ["portfolios"] });
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

        <Button
          type="button"
          disabled={m.isPending || from === to || !amount}
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
