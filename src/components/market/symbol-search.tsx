import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  HISTORY_SYMBOLS,
  isChartableSymbol,
  normaliseSymbolInput,
  type HistoryRange,
} from "@/lib/market-symbol-history";

interface Props {
  /** Range to open the chart at; defaults to the caller's current range. */
  range?: HistoryRange;
  className?: string;
  placeholder?: string;
}

/**
 * Free-form ticker box: charts any stock, ETF, index or crypto pair the price
 * feed knows (AAPL, MKS.L, ^FTSE, BTC-USD), with the curated pulse symbols
 * offered as suggestions.
 */
export function SymbolSearch({ range = 365, className, placeholder }: Props) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const symbol = normaliseSymbolInput(value);
    if (!isChartableSymbol(symbol)) {
      setError("Enter a ticker like AAPL, MKS.L, ^FTSE or BTC-USD.");
      return;
    }
    setError(null);
    void navigate({ to: "/market/$symbol", params: { symbol }, search: { range } });
  };

  return (
    <form onSubmit={submit} className={className}>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            list="chartable-symbols"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            aria-label="Chart any ticker"
            placeholder={placeholder ?? "Chart any ticker — AAPL, MKS.L, ^FTSE"}
            className="h-8 pl-8 text-xs uppercase placeholder:normal-case"
          />
          <datalist id="chartable-symbols">
            {HISTORY_SYMBOLS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <Button type="submit" size="sm" variant="secondary" className="h-8 px-3 text-xs">
          Chart
        </Button>
      </div>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
