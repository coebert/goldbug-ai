import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_ALERTS,
  isCritical,
  severityRank,
  sortAlerts,
} from "@/lib/alerts/registry";

describe("alert registry", () => {
  it("ranks critical above warning above info", () => {
    expect(severityRank("critical")).toBeLessThan(severityRank("warning"));
    expect(severityRank("warning")).toBeLessThan(severityRank("info"));
  });

  it("sorts by severity then declaration order", () => {
    const sorted = sortAlerts([
      { id: "a", severity: "info" as const },
      { id: "b", severity: "critical" as const },
      { id: "c", severity: "warning" as const },
      { id: "d", severity: "critical" as const },
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("keeps the risk halt first and every id unique", () => {
    const ordered = sortAlerts(PORTFOLIO_ALERTS);
    expect(ordered[0]?.id).toBe("risk-halt");
    expect(new Set(PORTFOLIO_ALERTS.map((a) => a.id)).size).toBe(PORTFOLIO_ALERTS.length);
    expect(PORTFOLIO_ALERTS.filter(isCritical).length).toBeGreaterThan(0);
  });
});
