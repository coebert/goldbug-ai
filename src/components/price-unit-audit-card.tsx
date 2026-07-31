import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ChevronDown, Loader2, Ruler } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  getPriceUnitAudit,
  type PriceUnitAuditResult,
} from "@/lib/price-unit-audit.functions";
import type { PriceUnitAuditRow } from "@/lib/price-unit-audit";

const SOURCE_LABEL: Record<PriceUnitAuditRow["price_source"], string> = {
  close: "close",
  carried_close: "carried",
  avg_cost: "avg cost",
  missing: "no price",
};

function fmt(value: number, dp = 2): string {
  return value.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function AuditRow({ row }: { row: PriceUnitAuditRow }) {
  return (
    <Collapsible asChild>
      <div className="rounded-lg border border-border/60 bg-card/40">
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 p-3 text-left">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-foreground">{row.symbol}</span>
              <Badge variant={row.pence_folded ? "default" : "secondary"} className="text-[10px]">
                {row.quote_currency}
                {row.pence_folded ? " ÷100" : ""}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {SOURCE_LABEL[row.price_source]}
              </Badge>
              {row.fx_source !== "identity" ? (
                <Badge
                  variant={row.fx_source === "assumed_identity" ? "destructive" : "outline"}
                  className="text-[10px]"
                >
                  {row.fx_pair} ×{fmt(row.fx_rate, 4)}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {fmt(row.quantity, 4)} × {fmt(row.raw_quote, 4)} {row.quote_currency}
              {row.pence_folded ? ` ÷ 100` : ""} = {fmt(row.value_instrument_ccy)}{" "}
              {row.instrument_ccy}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold tabular-nums text-foreground">
              {fmt(row.value_base)} {row.base_ccy}
            </p>
            <p className="text-[11px] text-muted-foreground">{fmt(row.weight * 100, 1)}%</p>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="space-y-2 border-t border-border/60 p-3">
            {row.steps.map((step, i) => (
              <li key={step.label} className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground">
                  <span className="mr-2 font-mono text-foreground">{i + 1}.</span>
                  <span className="font-medium text-foreground">{step.label}</span> — {step.detail}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-foreground">
                  {fmt(step.value, 4)} {step.unit}
                </span>
              </li>
            ))}
            {row.price_key ? (
              <li className="text-[11px] text-muted-foreground">
                Quote read from <span className="font-mono">{row.price_key}</span>
                {row.quote_date ? ` dated ${row.quote_date}` : ""}.
              </li>
            ) : null}
            {row.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2 text-[11px] text-destructive">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {w}
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * "Show me the arithmetic" panel: for any chosen day, replays every holding's
 * raw feed quote → pence fold → FX conversion, so a wrong tile can be traced
 * to the exact step that misfired.
 */
export function PriceUnitAuditCard({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const run = useServerFn(getPriceUnitAudit);
  const audit = useMutation<PriceUnitAuditResult>({
    mutationFn: () => run({ data: { portfolioId, date } }),
  });
  const data = audit.data;

  return (
    <Card className={className} data-testid="price-unit-audit-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Ruler className="h-4 w-4 text-primary" />
          Price-unit audit trail
        </CardTitle>
        <CardDescription>
          Shows exactly how each holding's value was computed for a day — the raw quote, whether
          pence were folded to pounds, and the FX rate applied.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="sm:w-48"
            aria-label="Audit date"
          />
          <Button
            onClick={() => audit.mutate()}
            disabled={audit.isPending}
            className="w-full sm:w-auto"
            data-testid="price-unit-audit-run"
          >
            {audit.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {audit.isPending ? "Auditing…" : "Show the arithmetic"}
          </Button>
        </div>

        {audit.isError ? (
          <p className="text-sm text-destructive">
            Audit failed:{" "}
            {audit.error instanceof Error ? audit.error.message : String(audit.error)}
          </p>
        ) : null}

        {data ? (
          <div className="space-y-3">
            {data.warnings.map((w) => (
              <p
                key={w}
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
              >
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {w}
              </p>
            ))}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Holdings", value: data.holdings_value },
                { label: "Cash", value: data.cash },
                { label: "Total", value: data.total_value },
                ...(data.stored
                  ? [{ label: "Stored snapshot", value: data.stored.total_value }]
                  : []),
              ].map((s) => (
                <div key={s.label} className="rounded-md border border-border/60 p-2">
                  <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  <p className="text-sm font-semibold tabular-nums text-foreground">
                    {fmt(s.value)} {data.base_ccy}
                  </p>
                </div>
              ))}
            </div>

            {data.by_currency.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                By settlement currency:{" "}
                {data.by_currency
                  .map(
                    (c) =>
                      `${c.currency} ×${fmt(c.fx_rate, 4)} → ${fmt(c.value_base)} ${data.base_ccy}`,
                  )
                  .join(" · ")}
              </p>
            ) : null}

            <div className="space-y-2">
              {data.rows.map((row) => (
                <AuditRow key={row.symbol} row={row} />
              ))}
            </div>

            {data.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No positions were open on {data.date}.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
