import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Brain, RefreshCw } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDecisionPlaybook, trainDecisionPlaybook } from "@/lib/decision-playbook.functions";

export const Route = createFileRoute("/decision-model")({
  component: DecisionModelPage,
  head: () => ({
    meta: [
      { title: "Trading playbook — written from your own account history" },
      {
        name: "description",
        content:
          "The rules the AI derived from your account's recorded decisions and realised, cost-adjusted results — the same playbook it applies when picking stocks each day.",
      },
      { property: "og:title", content: "Trading playbook from your account history" },
      {
        property: "og:description",
        content:
          "Entry and exit rules, sizing and cost discipline, each traced to what this book actually banked.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Confidence = "high" | "medium" | "low";

function confidenceVariant(c: Confidence): "default" | "secondary" | "outline" {
  return c === "high" ? "default" : c === "medium" ? "secondary" : "outline";
}

function RuleList({
  rules,
}: {
  rules: Array<{ rule: string; evidence: string; confidence: Confidence }>;
}) {
  return (
    <ul className="space-y-3">
      {rules.map((r, i) => (
        <li key={i} className="rounded-md border p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium leading-snug">{r.rule}</p>
            <Badge variant={confidenceVariant(r.confidence)} className="shrink-0 capitalize">
              {r.confidence}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{r.evidence}</p>
        </li>
      ))}
    </ul>
  );
}

function DecisionModelPage() {
  const load = useServerFn(getDecisionPlaybook);
  const train = useServerFn(trainDecisionPlaybook);
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["decision-playbook"],
    queryFn: () => load(),
  });

  const rewrite = useMutation({
    mutationFn: (realMoneyOnly: boolean) =>
      train({ data: { horizonDays: 5, realMoneyOnly } }),
    onSuccess: (res) => {
      setMessage(res.ok ? "Playbook rewritten from your latest history." : res.error);
      void qc.invalidateQueries({ queryKey: ["decision-playbook"] });
    },
    onError: (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)),
  });

  const stored = data?.stored ?? null;
  const pb = stored?.playbook ?? null;
  const cov = stored?.coverage ?? null;

  return (
    <>
      <AppHeader />
      <PageShell
        title={
          <span className="flex items-center gap-2">
            <Brain className="h-6 w-6 text-primary" aria-hidden />
            Trading playbook
          </span>
        }
        purpose="Written by the AI from your account's own record: every signal snapshot it was shown on a past day, matched against what you actually banked after costs. These are the rules it applies when it picks stocks."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => rewrite.mutate(true)}
              disabled={rewrite.isPending}
            >
              Rewrite from real trades only
            </Button>
            <Button onClick={() => rewrite.mutate(false)} disabled={rewrite.isPending}>
              <RefreshCw
                className={`mr-2 h-4 w-4 ${rewrite.isPending ? "animate-spin" : ""}`}
                aria-hidden
              />
              {rewrite.isPending ? "Studying your history…" : "Rewrite playbook"}
            </Button>
          </>
        }
      >
        {message ? (
          <p className="mb-4 text-sm text-muted-foreground" data-testid="playbook-message">
            {message}
          </p>
        ) : null}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !pb || !stored || !cov ? (
          <Card>
            <CardHeader>
              <CardTitle>No playbook yet</CardTitle>
              <CardDescription>
                Press “Rewrite playbook” and the AI will read your recorded decisions and results,
                then write the rules your own history supports. It needs at least 150 recorded
                observations.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-6" data-testid="playbook">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>What your record says</CardTitle>
                  <Badge variant={confidenceVariant(pb.overall_confidence)} className="capitalize">
                    {pb.overall_confidence} confidence
                  </Badge>
                </div>
                <CardDescription>
                  {cov.samples} observations of {cov.symbols} instruments over {cov.dates} trading
                  days ({cov.from ?? "?"} → {cov.to ?? "?"}), outcomes measured{" "}
                  {cov.horizonDays} days forward and net of the{" "}
                  {Math.round(cov.roundTripCostBps)}bps round trip this account pays. Last written{" "}
                  {stored.created_at.slice(0, 10)}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed">{pb.summary}</p>
              </CardContent>
            </Card>

            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>When to buy</CardTitle>
                </CardHeader>
                <CardContent>
                  <RuleList rules={pb.entry_rules} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>When to sell</CardTitle>
                </CardHeader>
                <CardContent>
                  <RuleList rules={pb.exit_rules} />
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>How big, and how often</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm leading-relaxed">
                  <p>{pb.sizing}</p>
                  <p className="text-muted-foreground">{pb.cost_discipline}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Favour and avoid</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div>
                    <p className="font-medium">Favour</p>
                    <p className="text-muted-foreground">{pb.favour.join("; ") || "—"}</p>
                  </div>
                  <div>
                    <p className="font-medium">Avoid</p>
                    <p className="text-muted-foreground">{pb.avoid.join("; ") || "—"}</p>
                  </div>
                  {pb.unknowns.length ? (
                    <div>
                      <p className="font-medium">Still unproven</p>
                      <p className="text-muted-foreground">{pb.unknowns.join("; ")}</p>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>The evidence it was written from</CardTitle>
                <CardDescription>
                  Measured straight from your history — no model, no assumptions.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
                  {stored.brief}
                </pre>
              </CardContent>
            </Card>
          </div>
        )}
      </PageShell>
    </>
  );
}
