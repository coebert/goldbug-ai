// Summary of the cost grid collapsed onto its two headline axes —
// slippage (how far the price moves against us per side) and the per-trade
// minimum commission — with the ticket sizes that stay viable in each cell.
//
// The optimiser evaluates every candidate in every cost scenario, which is a
// lot of numbers. The practical question behind all of them is narrow:
// "at this execution cost and this fee floor, how big does a ticket have to be
// before trading still makes money?" This module answers exactly that.
//
// Pure and deterministic: it consumes already-computed per-scenario metrics,
// never a tape or a simulator.

export type CostCellEntry = {
  /** Slippage axis label, e.g. "20bps". Use "baseline" when not varied. */
  slippageLabel: string;
  /** Total per-side proportional cost in bps, for ordering the axis. */
  slippageBps?: number;
  /** Per-trade commission floor in account currency. */
  minCommission: number;
  /** Ticket size in account currency (per-name weight x starting equity). */
  ticketGbp: number;
  /** Net CAGR after costs, in %. */
  cagrPct: number;
  /** Turnover, for reporting the cheapest viable configuration. */
  tradesPerYear?: number;
  /** Constraint outcome: infeasible configs can never be "viable". */
  feasible?: boolean;
  /** Optional identity for reporting the winning config in a cell. */
  id?: string;
};

export type TicketViability = {
  ticketGbp: number;
  /** Best net CAGR achieved at this ticket size within the cell. */
  bestCagrPct: number;
  /** Mean net CAGR across configurations at this ticket size. */
  meanCagrPct: number;
  configs: number;
  viable: boolean;
};

export type CostCell = {
  slippageLabel: string;
  slippageBps: number | null;
  minCommission: number;
  configs: number;
  bestCagrPct: number;
  medianCagrPct: number;
  /** Ticket-size breakdown, ascending by ticket. */
  tickets: TicketViability[];
  /** Ticket sizes that clear the viability bar, ascending. */
  viableTickets: number[];
  /** Smallest ticket that clears the bar, or null when none do. */
  minViableTicketGbp: number | null;
  /** Share of ticket sizes in the cell that clear the bar. */
  viableTicketShare: number;
  /** Identity of the best configuration in the cell, when supplied. */
  bestId: string | null;
};

export type CostAxisSummary = {
  /** Slippage axis values, ordered cheap → dear. */
  slippageLabels: string[];
  /** Min-fee axis values, ascending. */
  minCommissions: number[];
  cells: CostCell[];
  /** Ticket sizes seen anywhere in the grid, ascending. */
  ticketSizes: number[];
  /** Ticket sizes viable in EVERY cell — the cost-robust ticket band. */
  universallyViableTickets: number[];
  /** Ticket sizes viable in no cell at all. */
  neverViableTickets: number[];
  minCagrPct: number;
};

export type CostAxisSummaryOptions = {
  /** Net CAGR a ticket must clear to count as viable. Default 0. */
  minCagrPct?: number;
  /**
   * How a ticket size qualifies within a cell:
   *  - `best` (default): its best configuration clears the bar
   *  - `mean`: its average configuration clears the bar (stricter)
   */
  basis?: "best" | "mean";
};

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const cellKey = (slippageLabel: string, minCommission: number) =>
  `${slippageLabel}|${minCommission}`;

/**
 * Build the slippage × min-fee comparison grid, with the viable ticket sizes
 * highlighted in each cell.
 */
export function summariseCostAxes(
  entries: readonly CostCellEntry[],
  opts: CostAxisSummaryOptions = {},
): CostAxisSummary {
  if (entries.length === 0) throw new Error("summariseCostAxes: no entries");
  const minCagrPct = opts.minCagrPct ?? 0;
  const basis = opts.basis ?? "best";

  // Axis ordering: slippage by measured bps when available, else by label.
  const bpsByLabel = new Map<string, number | null>();
  for (const e of entries) {
    const prev = bpsByLabel.get(e.slippageLabel);
    if (prev === undefined || prev === null) {
      bpsByLabel.set(e.slippageLabel, Number.isFinite(e.slippageBps ?? NaN) ? e.slippageBps! : null);
    }
  }
  const slippageLabels = [...bpsByLabel.keys()].sort((a, b) => {
    const ba = bpsByLabel.get(a);
    const bb = bpsByLabel.get(b);
    if (ba !== null && ba !== undefined && bb !== null && bb !== undefined && ba !== bb) {
      return ba - bb;
    }
    return a.localeCompare(b);
  });
  const minCommissions = [...new Set(entries.map((e) => e.minCommission))].sort((a, b) => a - b);
  const ticketSizes = [...new Set(entries.map((e) => e.ticketGbp))].sort((a, b) => a - b);

  const grouped = new Map<string, CostCellEntry[]>();
  for (const e of entries) {
    const k = cellKey(e.slippageLabel, e.minCommission);
    const bucket = grouped.get(k);
    if (bucket) bucket.push(e);
    else grouped.set(k, [e]);
  }

  const cells: CostCell[] = [];
  for (const slippageLabel of slippageLabels) {
    for (const minCommission of minCommissions) {
      const rows = grouped.get(cellKey(slippageLabel, minCommission));
      if (!rows?.length) continue;

      const byTicket = new Map<number, CostCellEntry[]>();
      for (const r of rows) {
        const bucket = byTicket.get(r.ticketGbp);
        if (bucket) bucket.push(r);
        else byTicket.set(r.ticketGbp, [r]);
      }

      const tickets: TicketViability[] = [...byTicket.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ticketGbp, group]) => {
          // Infeasible configurations count towards the average but can never
          // make a ticket viable on their own.
          const eligible = group.filter((g) => g.feasible !== false);
          const bestCagrPct = eligible.length
            ? Math.max(...eligible.map((g) => g.cagrPct))
            : Math.max(...group.map((g) => g.cagrPct));
          const meanCagrPct = group.reduce((a, g) => a + g.cagrPct, 0) / group.length;
          const measure = basis === "mean" ? meanCagrPct : bestCagrPct;
          return {
            ticketGbp,
            bestCagrPct,
            meanCagrPct,
            configs: group.length,
            viable: eligible.length > 0 && measure >= minCagrPct - 1e-12,
          };
        });

      const feasibleRows = rows.filter((r) => r.feasible !== false);
      const pool = feasibleRows.length ? feasibleRows : rows;
      const best = pool.reduce((a, b) => (b.cagrPct > a.cagrPct ? b : a));
      const viableTickets = tickets.filter((t) => t.viable).map((t) => t.ticketGbp);

      cells.push({
        slippageLabel,
        slippageBps: bpsByLabel.get(slippageLabel) ?? null,
        minCommission,
        configs: rows.length,
        bestCagrPct: best.cagrPct,
        medianCagrPct: median(rows.map((r) => r.cagrPct)),
        tickets,
        viableTickets,
        minViableTicketGbp: viableTickets.length ? viableTickets[0]! : null,
        viableTicketShare: tickets.length ? viableTickets.length / tickets.length : 0,
        bestId: best.id ?? null,
      });
    }
  }

  const universallyViableTickets = ticketSizes.filter((t) =>
    cells.every((c) => c.viableTickets.includes(t)),
  );
  const neverViableTickets = ticketSizes.filter((t) =>
    cells.every((c) => !c.viableTickets.includes(t)),
  );

  return {
    slippageLabels,
    minCommissions,
    cells,
    ticketSizes,
    universallyViableTickets,
    neverViableTickets,
    minCagrPct,
  };
}

/** Compact money label, e.g. 1800 → "£1.8k". */
export function formatTicket(gbp: number, currency = "£"): string {
  const abs = Math.abs(gbp);
  if (abs >= 1000) return `${currency}${(gbp / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${currency}${Math.round(gbp)}`;
}

/** "£1.8k+" when the viable band is a contiguous tail, else an explicit list. */
export function formatViableTickets(
  cell: CostCell,
  allTickets: readonly number[],
  currency = "£",
): string {
  if (cell.viableTickets.length === 0) return "none";
  const tail = allTickets.filter((t) => t >= cell.minViableTicketGbp!);
  const isTail =
    tail.length === cell.viableTickets.length &&
    tail.every((t) => cell.viableTickets.includes(t));
  if (isTail) {
    return tail.length === allTickets.length
      ? "all"
      : `${formatTicket(cell.minViableTicketGbp!, currency)}+`;
  }
  return cell.viableTickets.map((t) => formatTicket(t, currency)).join(", ");
}

/**
 * Console-friendly matrix: one row per slippage level, one column per
 * min-fee level, each cell showing the smallest viable ticket size.
 */
export function renderCostAxisMatrix(summary: CostAxisSummary, currency = "£"): string[] {
  const colWidth = Math.max(
    12,
    ...summary.cells.map((c) => formatViableTickets(c, summary.ticketSizes, currency).length + 2),
  );
  const head =
    "slippage".padEnd(16) +
    summary.minCommissions.map((f) => `min ${currency}${f}`.padStart(colWidth)).join("");
  const lines = [head];
  for (const label of summary.slippageLabels) {
    let row = label.padEnd(16);
    for (const fee of summary.minCommissions) {
      const cell = summary.cells.find(
        (c) => c.slippageLabel === label && c.minCommission === fee,
      );
      row += (cell ? formatViableTickets(cell, summary.ticketSizes, currency) : "—").padStart(
        colWidth,
      );
    }
    lines.push(row);
  }
  return lines;
}

/** One-line verdict on the ticket band that survives the whole grid. */
export function describeCostAxisSummary(summary: CostAxisSummary, currency = "£"): string {
  const bar = `net CAGR ≥ ${summary.minCagrPct.toFixed(2)}%`;
  if (summary.universallyViableTickets.length === 0) {
    return `No ticket size clears ${bar} in every cost scenario (${summary.cells.length} cells).`;
  }
  const smallest = summary.universallyViableTickets[0]!;
  return (
    `Tickets from ${formatTicket(smallest, currency)} clear ${bar} in all ` +
    `${summary.cells.length} slippage × min-fee cells` +
    (summary.neverViableTickets.length
      ? `; ${summary.neverViableTickets.map((t) => formatTicket(t, currency)).join(", ")} never clear it.`
      : ".")
  );
}
