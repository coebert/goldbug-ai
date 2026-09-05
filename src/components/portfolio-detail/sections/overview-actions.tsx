import { Link } from "@tanstack/react-router";
import { CalendarClock, PlayCircle, RotateCcw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip as UITooltip,
  TooltipContent as UITooltipContent,
  TooltipProvider as UITooltipProvider,
  TooltipTrigger as UITooltipTrigger,
} from "@/components/ui/tooltip";

/** Manual run / backtest / reset controls for the portfolio overview tab. */
export function OverviewActions({
  id,
  days,
  setDays,
  runDayPending,
  runBtPending,
  resetPending,
  onRunDay,
  onRunBacktest,
  onRunFullHistoryBacktest,
  onReset,
}: {
  id: string;
  days: number;
  setDays: (v: number) => void;
  runDayPending: boolean;
  runBtPending: boolean;
  resetPending: boolean;
  onRunDay: () => void;
  onRunBacktest: () => void;
  onRunFullHistoryBacktest?: () => void;
  onReset: () => void;
}) {
  return (
    <Card id="actions" className="mb-6 scroll-below-sticky">
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <UITooltipProvider delayDuration={100}>
          <UITooltip>
            <UITooltipTrigger asChild>
              <Button onClick={onRunDay} disabled={runDayPending || runBtPending}>
                <Zap className="mr-1 h-4 w-4" />
                {runDayPending ? "Running…" : "Run one day now"}
              </Button>
            </UITooltipTrigger>
            <UITooltipContent className="max-w-xs">
              Manually triggers ONE AI decision cycle right now (fetches latest prices + news, asks
              the AI, applies guardrails, records any resulting trades). Same thing the hourly cron
              does when the portfolio is Active — use this to test or force a run without waiting
              for the next hour. Doesn't touch real money unless the portfolio is in Real money
              mode.
            </UITooltipContent>
          </UITooltip>
        </UITooltipProvider>
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Backtest days:</span>
          <div className="w-32">
            <Slider
              value={[days]}
              onValueChange={([v]) => setDays(v)}
              min={3}
              max={20}
              step={1}
            />
          </div>
          <span className="w-6 text-right text-sm tabular-nums">{days}</span>
        </div>
        <Button variant="outline" onClick={onRunBacktest} disabled={runBtPending || runDayPending}>
          <PlayCircle className="mr-1 h-4 w-4" />
          {runBtPending ? "Backtesting…" : `Run ${days}-day backtest`}
        </Button>
        {onRunFullHistoryBacktest && (
          <Button
            variant="outline"
            onClick={onRunFullHistoryBacktest}
            disabled={runBtPending || runDayPending}
          >
            <CalendarClock className="mr-1 h-4 w-4" />
            {runBtPending ? "Replaying…" : "Replay full history"}
          </Button>
        )}

        <Button variant="ghost" onClick={onReset} disabled={resetPending}>
          <RotateCcw className="mr-1 h-4 w-4" /> Reset
        </Button>
        <Link to="/long-horizon/$id" params={{ id }}>
          <Button variant="outline">
            <CalendarClock className="mr-1 h-4 w-4" /> Long-horizon backtest
          </Button>
        </Link>
        <Link to="/walk-forward/$id" params={{ id }}>
          <Button variant="outline">
            <CalendarClock className="mr-1 h-4 w-4" /> Walk-forward test
          </Button>
        </Link>

        {(runDayPending || runBtPending) && (
          <span className="text-xs text-muted-foreground">
            Fetching prices, reading news, asking the AI…
          </span>
        )}
      </CardContent>
    </Card>
  );
}
