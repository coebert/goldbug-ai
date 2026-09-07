import { governorForNav, minTicketBase } from "./cost-governor";
import { FRICTION_WINDOW_DAYS } from "./friction-kpi";

export type CashSnapshotInput = {
  date: string;
  cash: number | null;
  nav: number;
};

export type CashCostInput = {
  date: string;
  costBase: number;
};

export type CashReservePoint = {
  date: string;
  cash: number;
  nav: number;
  minimumBuy: number;
  dealingAllowance: number;
  allowanceRemaining: number;
  trailingCost: number;
};

const dayMs = 86_400_000;

export function buildCashReserveHistory(
  snapshots: readonly CashSnapshotInput[],
  costs: readonly CashCostInput[],
  windowDays = FRICTION_WINDOW_DAYS,
): CashReservePoint[] {
  const validCosts = costs
    .map((row) => ({ at: Date.parse(`${row.date.slice(0, 10)}T12:00:00Z`), cost: Math.max(0, Number(row.costBase)) }))
    .filter((row) => Number.isFinite(row.at) && Number.isFinite(row.cost));

  return snapshots
    .filter((row) => row.cash != null && Number.isFinite(Number(row.cash)) && Number.isFinite(Number(row.nav)) && Number(row.nav) > 0)
    .map((row) => {
      const date = row.date.slice(0, 10);
      const at = Date.parse(`${date}T12:00:00Z`);
      const windowStart = at - windowDays * dayMs;
      const trailingCost = validCosts.reduce(
        (sum, cost) => sum + (cost.at > windowStart && cost.at <= at ? cost.cost : 0),
        0,
      );
      const nav = Number(row.nav);
      const gov = governorForNav(nav);
      const dealingAllowance = nav * gov.costBudgetPctOfNav;
      return {
        date,
        cash: Number(row.cash),
        nav,
        minimumBuy: minTicketBase({ navBase: nav, ...gov }),
        dealingAllowance,
        allowanceRemaining: Math.max(0, dealingAllowance - trailingCost),
        trailingCost,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
