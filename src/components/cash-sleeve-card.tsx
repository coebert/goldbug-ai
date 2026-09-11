import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getCashSleeve, saveCashSleeve } from "@/lib/cash-sleeve.functions";

export function CashSleeveCard() {
  const load = useServerFn(getCashSleeve);
  const save = useServerFn(saveCashSleeve);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["cash-sleeve"], queryFn: () => load() });

  const [enabled, setEnabled] = useState(false);
  const [symbol, setSymbol] = useState("ERNS.L");
  const [buffer, setBuffer] = useState("1500");

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setSymbol(data.symbol);
    setBuffer(String(Math.round(data.buffer)));
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => save({ data: { enabled, symbol, buffer: Number(buffer) } }),
    onSuccess: () => {
      toast.success(
        enabled
          ? `Spare cash above £${Number(buffer).toFixed(0)} will be held in ${symbol}.`
          : "Spare cash will stay as cash.",
      );
      void qc.invalidateQueries({ queryKey: ["cash-sleeve"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Earn interest on spare cash</CardTitle>
        <CardDescription>
          Cash sitting at the broker earns nothing. Switch this on and anything above your working
          buffer is held in a short-dated bond fund that pays close to the Bank of England rate,
          and is sold back into cash the moment a trade needs the money.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="sleeve-enabled">Put spare cash to work</Label>
            <p className="text-xs text-muted-foreground">
              Trading always comes first: the buffer is refilled before anything else.
            </p>
          </div>
          <Switch
            id="sleeve-enabled"
            checked={enabled}
            disabled={isLoading}
            onCheckedChange={setEnabled}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sleeve-buffer">Cash always kept available (£)</Label>
            <Input
              id="sleeve-buffer"
              inputMode="decimal"
              value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
              disabled={isLoading}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sleeve-symbol">Fund to hold the cash in</Label>
            <Input
              id="sleeve-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              disabled={isLoading}
            />
          </div>
        </div>

        <Button
          onClick={() => mutation.mutate()}
          disabled={isLoading || mutation.isPending || Number.isNaN(Number(buffer))}
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
