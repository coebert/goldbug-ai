import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { SpilloverHeatmapViewer } from "@/components/spillover-heatmap-card";
import { getClusterSpilloverHeatmap } from "@/lib/spillover-heatmap.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/spillover")({
  head: () => ({
    meta: [
      { title: "Cluster Spillover Heatmap | Correlation Contagion" },
      {
        name: "description",
        content:
          "Interactive cluster-by-cluster correlation heatmap: calm rho, stress rho and the contagion uplift behind joint drawdown tails.",
      },
      { property: "og:title", content: "Cluster Spillover Heatmap" },
      {
        property: "og:description",
        content:
          "Hover any cluster pair to compare calm, stress and delta correlation with the window counts behind them.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SpilloverPage,
});

function SpilloverPage() {
  // Protected server fn: called from the component, never from a loader, so
  // prerender never runs it without a session.
  const fetchHeatmap = useServerFn(getClusterSpilloverHeatmap);
  const { data, isLoading, error } = useQuery({
    queryKey: ["cluster-spillover-heatmap"],
    queryFn: () => fetchHeatmap({ data: {} }),
    staleTime: 30 * 60_000,
  });

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <h1 className="mb-2 text-2xl font-semibold">Cluster spillover</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Which sector clusters tighten together when the tape turns. Calm and stress
        correlations are pooled from the same rolling windows the execution
        calibration uses, so the heatmap and the simulator always describe the same
        coupling.
      </p>

      {isLoading && (
        <Card>
          <CardHeader>
            <CardTitle>Fitting the coupling matrix…</CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardHeader>
            <CardTitle>Could not build the heatmap</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Unknown error."}
          </CardContent>
        </Card>
      )}

      {data && <SpilloverHeatmapViewer data={data} />}
    </div>
  );
}
