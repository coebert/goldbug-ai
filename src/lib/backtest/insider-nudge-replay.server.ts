// Data layer for the insider-nudge replay: pull ~1-2 years of filed director
// dealings plus the daily tape, then hand both to the pure replay engine.

import { getDailyCandlesRange, type Candle } from "@/lib/market-data.server";
import { classifyEvents } from "./insider-event-study";
import { fetchInsiderTransactions, MKS_PEERS } from "./insider-event-study.server";
import {
  runNudgeReplay,
  type NudgeReplayResult,
  type ReplayEvent,
  type ReplayParams,
} from "./insider-nudge-replay";
import {
  runNudgeWalkForward,
  type WalkForwardOptions,
  type WalkForwardResult,
} from "./insider-nudge-oos";
import type { InsiderFlavour } from "@/lib/insider-dealings";

export type NudgeReplayRequest = {
  symbols?: string[];
  /** Calendar days of history to replay (365-730 is the intended range). */
  lookbackDays?: number;
  /** Ignore dealings below this consideration. */
  minValue?: number;
  params?: Partial<ReplayParams>;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Pull the tape + filings once so single-pass and walk-forward share a loader. */
export async function loadReplayData(req: NudgeReplayRequest = {}): Promise<{
  prices: Map<string, Candle[]>;
  events: ReplayEvent[];
}> {
  const symbols = (req.symbols?.length ? req.symbols : [...MKS_PEERS]).map((s) =>
    s.trim().toUpperCase(),
  );
  const lookbackDays = Math.max(365, Math.min(900, req.lookbackDays ?? 730));
  const minValue = req.minValue ?? 100_000;

  const to = iso(new Date());
  // Extra warm-up so the 50-day average exists on the first replayed bar.
  const from = iso(new Date(Date.now() - (lookbackDays + 90) * 86_400_000));
  const eventsFrom = iso(new Date(Date.now() - lookbackDays * 86_400_000));

  const txs: ReplayEvent[] = [];
  for (let i = 0; i < symbols.length; i += 3) {
    const batch = symbols.slice(i, i + 3);
    const got = await Promise.all(batch.map((s) => fetchInsiderTransactions(s)));
    for (const rows of got) {
      for (const e of classifyEvents(rows)) {
        if (e.date < eventsFrom || e.date > to) continue;
        if (e.action === "other") continue;
        if (minValue > 0 && (e.value == null || Math.abs(e.value) < minValue)) continue;
        const flavour: InsiderFlavour =
          e.flavour === "discretionary" ? "discretionary" : e.flavour === "mechanical" ? "award" : "unknown";
        txs.push({
          symbol: e.symbol,
          date: e.date,
          direction: e.action,
          flavour,
          role: e.role,
          value: e.value,
        });
      }
    }
  }

  const prices = new Map<string, Candle[]>();
  const loadTape = async (sym: string) => {
    try {
      const c = await getDailyCandlesRange(sym, from, to);
      if (c.length > 0) prices.set(sym, c);
    } catch (err) {
      console.error(`insider-nudge-replay: tape failed for ${sym}`, err);
    }
  };
  for (let i = 0; i < symbols.length; i += 4) {
    await Promise.all(symbols.slice(i, i + 4).map(loadTape));
  }

  return { prices, events: txs };
}

export async function runInsiderNudgeReplay(
  req: NudgeReplayRequest = {},
): Promise<NudgeReplayResult> {
  const { prices, events } = await loadReplayData(req);
  return runNudgeReplay({ prices, events, params: req.params ?? {} });
}

/**
 * Rolling walk-forward: tune the nudge strength on the first N months of each
 * fold, then score the next M months untouched.
 */
export async function runInsiderNudgeWalkForward(
  req: NudgeReplayRequest & { options?: Partial<WalkForwardOptions> } = {},
): Promise<WalkForwardResult> {
  const { prices, events } = await loadReplayData(req);
  return runNudgeWalkForward({
    prices,
    events,
    params: req.params ?? {},
    options: req.options ?? {},
  });
}
