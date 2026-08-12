import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isChartableSymbol, normaliseSymbolInput, type HistoryRange } from "@/lib/market-symbol-history";
import { searchSymbols } from "@/lib/symbol-search.functions";
import { LOCAL_SUGGESTIONS, rankSuggestions, type SymbolSuggestion } from "@/lib/symbol-suggest";

interface Props {
  /** Range to open the chart at; defaults to the caller's current range. */
  range?: HistoryRange;
  className?: string;
  placeholder?: string;
}

/**
 * Free-form ticker box with autocomplete: charts any stock, ETF, index or
 * crypto pair the price feed knows (AAPL, MKS.L, ^FTSE, BTC-USD). Curated
 * pulse symbols match instantly; a debounced lookup adds live ticker matches.
 */
export function SymbolSearch({ range = 365, className, placeholder }: Props) {
  const navigate = useNavigate();
  const lookup = useServerFn(searchSymbols);
  const listId = useId();

  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<SymbolSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  const query = value.trim();

  // Debounced remote lookup; stale responses are discarded.
  useEffect(() => {
    if (query.length < 2) {
      setRemote([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void lookup({ data: { query } })
        .then((rows) => {
          if (!cancelled) setRemote(rows);
        })
        .catch(() => {
          if (!cancelled) setRemote([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
ங    };
  }, [query, lookup]);

  const options = useMemo(
    () => rankSuggestions([...LOCAL_SUGGESTIONS, ...remote], query, 8),
    [remote, query],
  );

  // Close the popover on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const go = (raw: string) => {
    const symbol = normaliseSymbolInput(raw);
    if (!isChartableSymbol(symbol)) {
      setError("Enter a ticker like AAPL, MKS.L, ^FTSE or BTC-USD.");
      return;
    }
    setError(null);
    setOpen(false);
    void navigate({ to: "/market/$symbol", params: { symbol }, search: { range } });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const picked = active >= 0 ? options[active] : undefined;
    go(picked ? picked.symbol : value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!options.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((prev) => {
        const next = e.key === "ArrowDown" ? prev + 1 : prev - 1;
        if (next < 0) return options.length - 1;
        if (next >= options.length) return 0;
        return next;
      });
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };

  const showList = open && (options.length > 0 || (loading && query.length >= 2));

  return (
    <form onSubmit={submit} className={className} role="search">
      <div className="flex items-center gap-2">
        <div ref={boxRef} className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setOpen(true);
              setActive(-1);
              if (error) setError(null);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
            autoComplete="off"
            aria-label="Chart any ticker"
            placeholder={placeholder ?? "Chart any ticker — AAPL, MKS.L, ^FTSE"}
            className="h-8 pl-8 pr-7 text-xs uppercase placeholder:normal-case"
          />
          {loading ? (
            <Loader2
              className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}

          {showList ? (
            <ul
              id={listId}
              role="listbox"
              className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg"
            >
              {options.map((o, i) => (
                <li key={`${o.source}-${o.symbol}`}>
                  <button
                    type="button"
                    id={`${listId}-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(o.symbol)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs ${
                      i === active ? "bg-accent text-accent-foreground" : "text-foreground"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{o.symbol}</span>
                      <span className="ml-2 truncate text-muted-foreground">{o.label}</span>
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {o.kind}
                    </span>
                  </button>
                </li>
              ))}
              {!options.length && loading ? (
                <li className="px-2 py-1.5 text-xs text-muted-foreground">Searching…</li>
              ) : null}
            </ul>
          ) : null}
        </div>
        <Button type="submit" size="sm" variant="secondary" className="h-8 px-3 text-xs">
          Chart
        </Button>
      </div>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
