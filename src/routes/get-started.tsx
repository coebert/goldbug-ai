import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createPortfolio, runBacktest } from "@/lib/trading.functions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { AppHeader } from "@/components/app-header";
import { PageLoading } from "@/components/page-loading";
import { toast } from "sonner";
import {
  Shield,
  Scale,
  Flame,
  Check,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  PoundSterling,
  Ban,
  Bot,
} from "lucide-react";

export const Route = createFileRoute("/get-started")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Get started — Your £1000 demo portfolio | Aegis" },
      {
        name: "description",
        content:
          "Guided setup for your first simulated £1000 AI-managed portfolio. No real money, no leverage — just a safe way to see how the AI trades.",
      },
      { property: "og:title", content: "Start your £1000 demo — Aegis" },
      {
        property: "og:description",
        content:
          "Walk through a 3-step setup and run your first AI paper trade in seconds.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GetStarted,
});

type Risk = "conservative" | "balanced" | "aggressive";
type AssetClass = "stock" | "etf" | "crypto" | "commodity" | "fx";

const RISK_CHOICES: {
  id: Risk;
  title: string;
  tagline: string;
  bullets: string[];
  icon: typeof Shield;
}[] = [
  {
    id: "conservative",
    title: "Conservative",
    tagline: "Slow and steady",
    bullets: [
      "Max 10% of pot in any one asset",
      "Keeps at least 20% in cash",
      "Prefers ETFs & large caps",
    ],
    icon: Shield,
  },
  {
    id: "balanced",
    title: "Balanced",
    tagline: "A sensible starting point",
    bullets: [
      "Max 15% per asset",
      "Keeps at least 10% in cash",
      "Mix of ETFs, stocks & a little crypto",
    ],
    icon: Scale,
  },
  {
    id: "aggressive",
    title: "Aggressive",
    tagline: "Chases bigger swings",
    bullets: [
      "Max 25% per asset",
      "Can be fully invested",
      "Higher weighting to crypto & momentum stocks",
    ],
    icon: Flame,
  },
];

const CLASS_CHOICES: {
  id: AssetClass;
  label: string;
  desc: string;
}[] = [
  { id: "etf", label: "ETFs", desc: "Index funds — the broad market" },
  { id: "stock", label: "Stocks", desc: "Individual companies (US, UK, EU)" },
  { id: "crypto", label: "Crypto", desc: "BTC, ETH, SOL — higher volatility" },
  { id: "commodity", label: "Commodities", desc: "Gold, silver, oil" },
  { id: "fx", label: "FX", desc: "GBP/USD, EUR/USD currency pairs" },
];

function GetStarted() {
  const navigate = useNavigate();
  const [session, setSession] =
    useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (!data.session) navigate({ to: "/auth" });
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) navigate({ to: "/auth" });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [risk, setRisk] = useState<Risk>("balanced");
  const [classes, setClasses] = useState<AssetClass[]>([
    "etf",
    "stock",
    "crypto",
    "commodity",
  ]);

  const toggleClass = (c: AssetClass) =>
    setClasses((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );

  const create = useServerFn(createPortfolio);
  const backtest = useServerFn(runBacktest);

  const launch = useMutation({
    mutationFn: async () => {
      const created = await create({
        data: {
          name: "My £1000 Demo",
          starting_cash: 1000,
          currency: "GBP",
          risk_level: risk,
          universe: classes,
          mode: "backtest",
        },
      });
      await backtest({ data: { portfolio_id: created.id, days: 5 } });
      return created.id;
    },
    onSuccess: (id) => {
      toast.success("Demo portfolio ready — here are your first trades");
      navigate({ to: "/portfolio/$id/", params: { id } });
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Something went wrong"),
  });

  if (!ready || !session) {
    return (
      <PageLoading />
    );
  }

  const totalSteps = 4;

  return (
    <div className="min-h-dvh">
      <AppHeader email={session.user.email} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" className="text-sm text-muted-foreground hover:underline">
            ← Back to portfolios
          </Link>
          <div className="text-xs text-muted-foreground">
            Step {step + 1} of {totalSteps}
          </div>
        </div>

        <div className="mb-8 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${((step + 1) / totalSteps) * 100}%` }}
          />
        </div>

        {step === 0 && (
          <Card>
            <CardHeader>
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <PoundSterling className="h-6 w-6 text-primary" />
              </div>
              <CardTitle className="text-2xl">Your £1000 demo investment</CardTitle>
              <CardDescription className="text-base">
                A safe way to see how the AI trades — before you ever think about
                real money.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Feature
                  icon={PoundSterling}
                  title="£1000 pretend pot"
                  desc="Simulated cash only. Nothing leaves your bank."
                />
                <Feature
                  icon={Ban}
                  title="No borrowing"
                  desc="No leverage, no margin. It can only spend what it has."
                />
                <Feature
                  icon={Bot}
                  title="AI decides daily"
                  desc="Reads prices & news, picks trades, explains why."
                />
              </div>
              <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                Next you'll pick a <b>risk level</b> and the <b>types of assets</b>{" "}
                the AI is allowed to touch. Then we'll simulate the last few
                trading days so you can watch its first decisions.
              </div>
              <div className="flex justify-end">
                <Button onClick={() => setStep(1)} size="lg">
                  Let's go <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">How much risk should it take?</CardTitle>
              <CardDescription>
                You can change this later. Balanced is a good default for a first
                run.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                {RISK_CHOICES.map((r) => {
                  const active = risk === r.id;
                  const Icon = r.icon;
                  return (
                    <button
                      key={r.id}
                      onClick={() => setRisk(r.id)}
                      className={`rounded-lg border p-4 text-left transition ${
                        active
                          ? "border-primary bg-primary/5 ring-2 ring-primary/40"
                          : "hover:border-primary/40"
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <Icon className="h-5 w-5 text-primary" />
                        {active && <Check className="h-4 w-4 text-primary" />}
                      </div>
                      <div className="font-semibold">{r.title}</div>
                      <div className="mb-2 text-xs text-muted-foreground">
                        {r.tagline}
                      </div>
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {r.bullets.map((b) => (
                          <li key={b}>• {b}</li>
                        ))}
                      </ul>
                    </button>
                  );
                })}
              </div>
              <StepNav onBack={() => setStep(0)} onNext={() => setStep(2)} onSkip={() => navigate({ to: "/" })} />
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">What can it invest in?</CardTitle>
              <CardDescription>
                Pick at least one. The AI will only choose from the categories you
                tick.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                {CLASS_CHOICES.map((c) => {
                  const active = classes.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                        active
                          ? "border-primary bg-primary/5"
                          : "hover:border-primary/40"
                      }`}
                    >
                      <Checkbox
                        checked={active}
                        onCheckedChange={() => toggleClass(c.id)}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="text-sm font-medium">{c.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.desc}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <StepNav
                onBack={() => setStep(1)}
                onNext={() => setStep(3)}
                onSkip={() => navigate({ to: "/" })}
                nextDisabled={classes.length === 0}
              />
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <CardHeader>
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <CardTitle className="text-2xl">Ready to run</CardTitle>
              <CardDescription>
                We'll create your demo portfolio and replay the last 5 trading
                days so the AI can make its first decisions right away.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border p-4">
                <Summary label="Starting pot" value="£1000 (simulated)" />
                <Summary
                  label="Risk"
                  value={RISK_CHOICES.find((r) => r.id === risk)!.title}
                />
                <Summary
                  label="Assets"
                  value={classes
                    .map((c) => CLASS_CHOICES.find((x) => x.id === c)!.label)
                    .join(", ")}
                />
                <Summary label="Mode" value="Backtest (5 days)" />
              </div>
              <div className="rounded-lg border bg-muted/40 p-4 text-xs text-muted-foreground">
                This takes ~30–60 seconds while the AI reviews prices, news and
                runs its guardrail checks for each day.
              </div>
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  onClick={() => setStep(2)}
                  disabled={launch.isPending}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" /> Back
                </Button>
                <Button
                  size="lg"
                  onClick={() => launch.mutate()}
                  disabled={launch.isPending}
                >
                  {launch.isPending
                    ? "Running your first trades…"
                    : "Run my £1000 demo"}
                  {!launch.isPending && <ArrowRight className="ml-1 h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}

function Feature({
  icon: Icon,
  title,
  desc,
}: {
  icon: typeof Shield;
  title: string;
  desc: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <Icon className="mb-2 h-5 w-5 text-primary" />
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground">{desc}</div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function StepNav({
  onBack,
  onNext,
  onSkip,
  nextDisabled,
  nextLabel = "Continue",
}: {
  onBack: () => void;
  onNext: () => void;
  onSkip?: () => void;
  nextDisabled?: boolean;
  nextLabel?: string;
}) {
  return (
    <div className="sticky bottom-0 -mx-6 -mb-6 border-t border-border bg-card px-6 py-3 sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:p-0 sm:pt-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onBack} className="min-h-[44px]">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back
        </Button>
        {onSkip && (
          <Button
            variant="ghost"
            onClick={onSkip}
            className="min-h-[44px] text-muted-foreground"
          >
            Skip for now
          </Button>
        )}
        <Button
          onClick={onNext}
          disabled={nextDisabled}
          className="ml-auto min-h-[44px] flex-1 sm:flex-none"
        >
          {nextLabel} <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
