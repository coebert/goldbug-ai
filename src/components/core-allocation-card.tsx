import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { getCoreAllocation, saveCoreAllocation } from "@/lib/core-allocation.functions";

export function CoreAllocationCard() {
  const load = useServerFn(getCoreAllocation);
  const save = useServerFn(saveCoreAllocation);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["core-allocation"],
    queryFn: () => load(),
  });

  const [target, setTarget] = useState(0);
  const [band, setBand] = useState(5);
  const [symbol, setSymbol] = useState("VWRL.L");

  useEffect(() => {
    if (!data) return;
    setTarget(Math.round(data.targetPct * 100));
    setBand(Math.round(data.bandPct * 100));
    setSymbol(data.symbol);
  }, [data]);

  const mutation = useMutation({
    mutationFn: () =>
      save({ data: { targetPct: target / 100, symbol, bandPct: band / 100 } }),
    onSuccess: () => {
      toast.success(
        target === 0
          ? "Long-term holding switched off."
          : `Keeping about ${target}% of the account in ${symbol}.`,
      );
      void qc.invalidateQueries({ queryKey: ["core-allocation"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Long-term holding</CardTitle>
        <CardDescription>
          Cash that sits idle earns nothing, and on this account's own history that has been the
          biggest single drag on profit. Set a share of the account to keep permanently invested in
          one broad fund. The app tops it up with spare cash and trims it back if it grows too
          large, while the rest of the money keeps trading as usual. Set it to 0% to switch it off.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label>Share of the account held long term</Label>
            <span className="text-lg font-semibold tabular-nums">{target}%</span>
          </div>
          <Slider
            value={[target]}
            min={0}
            max={90}
            step={5}
            onValueChange={(v) => setTarget(v[0] ?? 0)}
            disabled={isLoading}
          />
          <p className="text-xs text-muted-foreground">
            Higher usually means more profit over time, but bigger dips along the way.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="core-symbol">Fund to hold</Label>
            <Input
              id="core-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              disabled={isLoading}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label>Drift allowed before acting</Label>
              <span className="text-sm font-medium tabular-nums">{band}%</span>
            </div>
            <Slider
              value={[band]}
              min={1}
              max={20}
              step={1}
              onValueChange={(v) => setBand(v[0] ?? 5)}
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              A wider band means fewer top-ups and less money spent on dealing charges.
            </p>
          </div>
        </div>

        <Button onClick={() => mutation.mutate()} disabled={isLoading || mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
