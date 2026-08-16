// Shared console reporting for the thesis-break replays: which positions the
// layer trimmed, which it closed, and which evidence streams agreed each time.
// Pure — returns lines, prints nothing.

import { signalKind, type ArmResult, type ThesisBreakEvent } from "./thesis-break-replay";

const pad = (s: string | number, n: number) => String(s).padStart(n);
const padR = (s: string | number, n: number) => String(s).padEnd(n);

/** Trim/close counts and the stream-agreement tally for one arm. */
export function thesisActionSummary(arm: ArmResult): string[] {
  const out: string[] = [];
  const { trim, close } = arm.actionMix;
  out.push(
    `${arm.arm}: ${arm.thesisEvents.length} thesis-break actions ` +
      `(${trim} trim, ${close} close)`,
  );
  if (arm.thesisEvents.length === 0) return out;

  const entries = Object.entries(arm.signalCounts).sort((a, b) => b[1] - a[1]);
  out.push("  agreeing streams (times counted across all firings):");
  for (const [k, v] of entries) {
    out.push(`    ${padR(k, 26)} ${pad(v, 4)}  ${((v / arm.thesisEvents.length) * 100).toFixed(0)}% of firings`);
  }

  // Which combinations actually fired together.
  const combos = new Map<string, number>();
  for (const e of arm.thesisEvents) {
    const key = e.signals.map(signalKind).sort().join(" + ") || "(none)";
    combos.set(key, (combos.get(key) ?? 0) + 1);
  }
  out.push("  signal combinations:");
  for (const [k, v] of [...combos].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    out.push(`    ${pad(v, 3)}x  ${k}`);
  }
  return out;
}

/** One line per trim/close, in date order. */
export function thesisActionLog(arm: ArmResult, limit = 60): string[] {
  const out: string[] = [];
  const events = [...arm.thesisEvents].sort((a, b) => a.date.localeCompare(b.date));
  out.push(
    [
      padR("Date", 11),
      padR("Symbol", 8),
      padR("Action", 7),
      pad("Sold%", 6),
      pad("Unreal%", 8),
      pad("Stop%", 6),
      pad("Prior", 6),
      " Signals",
    ].join(" "),
  );
  for (const e of events.slice(0, limit)) {
    out.push(
      [
        padR(e.date, 11),
        padR(e.symbol, 8),
        padR(e.action, 7),
        pad((e.sellFraction * 100).toFixed(0), 6),
        pad((e.unrealisedPct * 100).toFixed(2), 8),
        pad((e.effectiveStopPct * 100).toFixed(1), 6),
        pad(e.priorLosses, 6),
        " " + e.signals.map(signalKind).join(" + "),
      ].join(" "),
    );
  }
  if (events.length > limit) out.push(`  … ${events.length - limit} more`);
  return out;
}

/** Per-trade view: did this round-trip get trimmed before it closed? */
export function trimmedTradeLog(arm: ArmResult, limit = 40): string[] {
  const rows = arm.trades.filter((t) => t.thesisActions.length > 0);
  const out: string[] = [
    `${rows.length} of ${arm.trades.length} round-trips saw a thesis-break action`,
  ];
  if (rows.length === 0) return out;
  out.push(
    [
      padR("Symbol", 8),
      padR("Entry", 11),
      padR("Exit", 11),
      pad("Ret%", 8),
      pad("Trimmed%", 9),
      padR("  Exit path", 24),
    ].join(" "),
  );
  for (const t of rows.slice(0, limit)) {
    const path = t.thesisActions.map((a: ThesisBreakEvent) => a.action).join("→") +
      (t.thesisBreak ? "" : ` then ${t.exitReason.split("(")[0]!.trim()}`);
    out.push(
      [
        padR(t.symbol, 8),
        padR(t.entryDate, 11),
        padR(t.exitDate, 11),
        pad((t.returnPct * 100).toFixed(2), 8),
        pad((t.trimmedFraction * 100).toFixed(0), 9),
        "  " + path,
      ].join(" "),
    );
  }
  if (rows.length > limit) out.push(`  … ${rows.length - limit} more`);
  return out;
}

/** Full block for one arm. */
export function thesisArmReport(arm: ArmResult, label = arm.arm): string[] {
  return [
    "",
    `── ${label} ──`,
    ...thesisActionSummary(arm),
    "",
    ...thesisActionLog(arm),
    "",
    ...trimmedTradeLog(arm),
  ];
}
