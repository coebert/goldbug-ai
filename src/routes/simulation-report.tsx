import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  ScenarioReportCard, buildDemoScenarioInput,
} from "@/components/scenario-report-card";

export const Route = createFileRoute("/simulation-report")({
  head: () => ({
    meta: [
      { title: "Simulation Performance Report" },
      {
        name: "description",
        content:
          "Equity curves, drawdown, CAGR, Sharpe, and win-rate across a matrix of liquidity and friction scenarios.",
      },
      { property: "og:title", content: "Simulation Performance Report" },
      {
        property: "og:description",
        content:
          "Cross-scenario performance metrics for the broker-simulator matrix.",
      },
    ],
  }),
  component: SimulationReportPage,
});

function SimulationReportPage() {
  const input = useMemo(() => buildDemoScenarioInput(), []);
  return (
    <div className="container mx-auto max-w-6xl 2xl:max-w-7xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">
        Simulation Performance Report
      </h1>
      <ScenarioReportCard input={input} />
    </div>
  );
}
