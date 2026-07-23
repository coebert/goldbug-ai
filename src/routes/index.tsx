import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, lazy, Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listPortfolios,
  createPortfolio,
  deletePortfolio,
  getAllPortfoliosEquity,
} from "@/lib/trading.functions";
import { activateLive, getSaxoOAuthStatus, previewBrokerBalance } from "@/lib/live.functions";
import { Sparkline } from "@/components/sparkline";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { AppHeader } from "@/components/app-header";
import { ModeBadge } from "@/components/mode-badge";
import { LiveToggle } from "@/components/live-toggle";
const AllPortfoliosChart = lazy(() =>
  import("@/components/all-portfolios-chart").then((m) => ({ default: m.AllPortfoliosChart })),
);
const NewsReel = lazy(() =>
  import("@/components/news-reel").then((m) => ({ default: m.NewsReel })),
);
const DecisionNewsBreakdown = lazy(() =>
  import("@/components/decision-news-breakdown").then((m) => ({ default: m.DecisionNewsBreakdown })),
);

import { toast } from "sonner";
import { Trash2, PlayCircle, PlusCircle, Sparkles, BookOpen, X, FlaskConical, Beaker, Banknote, AlertTriangle, ExternalLink, RefreshCw, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Explain } from "@/components/explain";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Aegis — Your AI Paper Portfolios" },
      {
        name: "description",
        content: "Manage AI-driven paper trading portfolios. Backtest, run daily, watch results.",
      },
    ],
  }),
  component: Home,
});

const RISK_LABELS: Record<string, string> = {
  conservative: "Conservative — max 10% per asset, 20% cash floor",
  balanced: "Balanced — max 15% per asset, 10% cash floor",
  aggressive: "Aggressive — max 25% per asset, no cash floor",
};

const CLASS_LABELS: Record<string, string> = {
  stock: "Individual stocks (US + UK/EU)",
  etf: "ETFs (index funds)",
  crypto: "Crypto (BTC, ETH, SOL)",
  commodity: "Commodities (gold, silver, oil)",
  fx: "FX (GBP/USD, EUR/USD)",
};

function Home() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
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

  const list = useServerFn(listPortfolios);
  const q = useQuery({
    queryKey: ["portfolios"],
    queryFn: () => list(),
    enabled: !!session,
  });

  if (!ready || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <AppHeader email={session.user.email} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Your Portfolios</h1>
            <p className="text-sm text-muted-foreground">
              Create a portfolio, pick a risk level, run a backtest, then let the AI make daily decisions.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/get-started">
              <Button variant="secondary" size="sm">
                <Sparkles className="mr-1 h-4 w-4" /> £1000 demo
              </Button>
            </Link>
            <Link to="/saxo-status">
              <Button variant="outline" size="sm" title="Connect your Saxo account to trade real money">
                <Banknote className="mr-1 h-4 w-4" /> Real money setup
              </Button>
            </Link>
            <Link to="/compare">
              <Button variant="outline" size="sm">Compare</Button>
            </Link>
          </div>
        </div>

        <NewHereBanner />

        <div className="mb-6">
          <Suspense fallback={<div className="h-64 rounded-md border bg-card/50" aria-hidden="true" />}>
            <AllPortfoliosChart />
          </Suspense>
        </div>

        <div className="mb-6">
          <Suspense fallback={<div className="h-80 rounded-md border bg-card/50" aria-hidden="true" />}>
            <NewsReel />
          </Suspense>
        </div>

        <div className="mb-6">
          <Suspense fallback={<div className="h-80 rounded-md border bg-card/50" aria-hidden="true" />}>
            <DecisionNewsBreakdown />
          </Suspense>
        </div>




        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-3">
            {q.isLoading && <p className="text-sm text-muted-foreground">Loading portfolios…</p>}
            {q.data && q.data.length === 0 && (
              <Card className="border-primary/40 bg-primary/5">
                <CardContent className="flex flex-col items-start gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      <Sparkles className="h-4 w-4 text-primary" />
                      Start with a guided £1000 demo
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      A 3-step walkthrough that creates your first paper portfolio and runs the AI's first trades — no real money.
                    </p>
                  </div>
                  <Link to="/get-started">
                    <Button>Start demo</Button>
                  </Link>
                </CardContent>
              </Card>
            )}
            {q.data?.map((p) => (
              <PortfolioRow key={p.id} portfolio={p} />
            ))}
          </div>
          <CreatePortfolioCard />
        </div>
      </main>
    </div>
  );
}

function NewHereBanner() {
  const [hidden, setHidden] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("aegis.hideNewHereBanner") === "1";
  });
  if (hidden) return null;
  return (
    <div className="mb-6 flex items-start justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-4 py-3">
      <div className="flex items-start gap-3">
        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="text-sm">
          <div className="font-medium">New to trading? Read this first.</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Anything with a dotted underline in the app opens a plain-English explanation. Or open the full guide.
          </p>
          <Link to="/learn" className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
            Open the Learn page →
          </Link>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          window.localStorage.setItem("aegis.hideNewHereBanner", "1");
          setHidden(true);
        }}
        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function PortfolioRow({ portfolio }: { portfolio: { id: string; name: string; starting_cash: number; current_cash: number; currency: string; risk_level: string; mode: string; live_paused?: boolean | null; last_run_date: string | null } }) {
  const del = useServerFn(deletePortfolio);
  const qc = useQueryClient();
  const deleteMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      toast.success("Portfolio deleted");
      qc.invalidateQueries({ queryKey: ["portfolios"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const pnl = Number(portfolio.current_cash) - Number(portfolio.starting_cash);
  const pnlPct = (pnl / Number(portfolio.starting_cash)) * 100;

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/portfolio/$id"
              params={{ id: portfolio.id }}
              className="font-medium hover:underline"
            >
              {portfolio.name}
            </Link>
            <ModeBadge mode={portfolio.mode} size="sm" />
            <LiveToggle portfolioId={portfolio.id} mode={portfolio.mode} livePaused={portfolio.live_paused} size="sm" />
          </div>
          <div className="text-xs text-muted-foreground">
            {portfolio.currency} {Number(portfolio.starting_cash).toFixed(0)} · {portfolio.risk_level} risk
            {portfolio.last_run_date && ` · last run ${portfolio.last_run_date}`}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-sm font-medium">
              {portfolio.currency} {Number(portfolio.current_cash).toFixed(2)}
            </div>
            <div className={`text-xs ${pnl >= 0 ? "text-primary" : "text-destructive"}`}>
              (cash-only) {pnl >= 0 ? "+" : ""}
              {pnlPct.toFixed(2)}%
            </div>
          </div>
          <Link to="/portfolio/$id" params={{ id: portfolio.id }}>
            <Button size="sm" variant="outline">
              <PlayCircle className="mr-1 h-4 w-4" /> Open
            </Button>
          </Link>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              if (confirm("Delete this portfolio?")) deleteMut.mutate(portfolio.id);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type PortfolioMode = "backtest" | "live_sim" | "live_prod";

const MODE_META: Record<PortfolioMode, {
  label: string;
  short: string;
  icon: typeof FlaskConical;
  blurb: string;
  cta: string;
  needsSaxo: boolean;
  targetEnv?: "sim" | "prod";
}> = {
  backtest: {
    label: "Backtest",
    short: "Simulated cash",
    icon: FlaskConical,
    blurb: "Run the AI over historical prices with virtual money. Nothing hits your broker.",
    cta: "Create backtest portfolio",
    needsSaxo: false,
  },
  live_sim: {
    label: "Live paper (Saxo SIM)",
    short: "Simulated cash on Saxo",
    icon: Beaker,
    blurb: "Route AI orders through Saxo's SIM environment. Starting cash is read from your Saxo SIM balance. No real money at risk.",
    cta: "Create & activate on Saxo SIM",
    needsSaxo: true,
    targetEnv: "sim",
  },
  live_prod: {
    label: "Real money (Saxo LIVE)",
    short: "Real cash on Saxo",
    icon: Banknote,
    blurb: "The AI will place real orders on your live Saxo account. Starting cash is taken from your Saxo LIVE balance. Cash-only, no leverage, guardrails enforced.",
    cta: "Create & go live with real money",
    needsSaxo: true,
    targetEnv: "prod",
  },
};

function CreatePortfolioCard() {
  const create = useServerFn(createPortfolio);
  const activate = useServerFn(activateLive);
  const saxoStatus = useServerFn(getSaxoOAuthStatus);
  const previewBal = useServerFn(previewBrokerBalance);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [mode, setMode] = useState<PortfolioMode>("backtest");
  const [name, setName] = useState("My Portfolio");
  const [cash, setCash] = useState(1000);
  const [currency, setCurrency] = useState<"GBP" | "USD" | "EUR">("GBP");
  const [risk, setRisk] = useState<"conservative" | "balanced" | "aggressive">("balanced");
  const [classes, setClasses] = useState<string[]>(["stock", "etf", "crypto", "commodity", "fx"]);
  const [ackRisk, setAckRisk] = useState(false);

  const meta = MODE_META[mode];
  const isLive = mode !== "backtest";

  const saxoQ = useQuery({
    queryKey: ["saxo-oauth-status"],
    queryFn: () => saxoStatus({}),
    refetchInterval: 30_000,
  });

  const envKey = meta.targetEnv === "prod" ? "live" : "sim";
  const saxoEnvStatus = meta.targetEnv ? saxoQ.data?.[envKey] : null;
  const saxoReady = !!saxoEnvStatus && (saxoEnvStatus.connected || saxoEnvStatus.usingLegacyToken);

  const balQ = useQuery({
    queryKey: ["broker-balance-preview", meta.targetEnv],
    queryFn: () => previewBal({ data: { env: meta.targetEnv === "prod" ? "live" : "sim" } }),
    enabled: isLive && saxoReady,
    staleTime: 30_000,
  });

  const toggleClass = (c: string) =>
    setClasses((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const mut = useMutation({
    mutationFn: async () => {
      // Portfolios are always created in backtest mode server-side, then
      // "activated" onto the broker for live_sim / live_prod. This mirrors the
      // manual flow on the portfolio detail page but bundles it into a single
      // click so users don't have to hunt for the live-trading card afterwards.
      const created = await create({
        data: {
          name,
          starting_cash: cash,
          currency,
          risk_level: risk,
          universe: classes as ("stock" | "etf" | "crypto" | "commodity" | "fx")[],
          mode: "backtest",
        },
      });
      if (meta.targetEnv) {
        try {
          await activate({
            data: {
              portfolioId: created.id,
              targetEnv: meta.targetEnv,
              useBrokerBalance: true,
              acknowledgeRisk: true,
            },
          });
        } catch (e) {
          toast.error(
            `Portfolio created, but activating on Saxo ${meta.targetEnv.toUpperCase()} failed: ${e instanceof Error ? e.message : "unknown error"}. You can retry from the portfolio page.`,
          );
        }
      }
      return created;
    },
    onSuccess: (r) => {
      toast.success(
        mode === "live_prod"
          ? "Real-money portfolio created — trading is now live on Saxo."
          : mode === "live_sim"
            ? "Portfolio created and activated on Saxo SIM."
            : "Portfolio created.",
      );
      qc.invalidateQueries({ queryKey: ["portfolios"] });
      navigate({ to: "/portfolio/$id", params: { id: r.id } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const disabled =
    mut.isPending ||
    classes.length === 0 ||
    (isLive && !saxoReady) ||
    (mode === "live_prod" && !ackRisk);

  const fmtMoney = (n: number, ccy: string) => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${ccy} ${n.toFixed(2)}`;
    }
  };

  const onSubmit = () => {
    if (mode === "live_prod") {
      const bal = balQ.data;
      const pot = bal ? (bal.cashAvailable ?? bal.cash) : null;
      const pending = bal?.transactionsNotBooked ?? 0;
      const reserved = bal?.reservedCash ?? 0;
      const amountLine = bal
        ? `\n\nStarting cash (available/settled): ${fmtMoney(pot ?? 0, bal.currency)}` +
          (pending ? `\nPending / unsettled (excluded): ${fmtMoney(pending, bal.currency)}` : "") +
          (reserved ? `\nReserved by open orders (excluded): ${fmtMoney(reserved, bal.currency)}` : "") +
          `\nFrom Saxo LIVE account ${bal.accountId ?? "—"}.`
        : `\n\nStarting cash will be read from your Saxo LIVE available balance.`;
      const ok = window.confirm(
        `Create "${name}" and start trading REAL MONEY on your Saxo LIVE account?${amountLine}\n\nThe AI will place real orders on every hourly cycle. You can pause or revert at any time.`,
      );
      if (!ok) return;
    }
    mut.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlusCircle className="h-4 w-4 text-primary" /> New portfolio
        </CardTitle>
        <CardDescription>Pick what kind of money to trade with, then set it up.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode picker — first choice so users see there IS a real-money path. */}
        <div>
          <Label>Money type</Label>
          <div className="mt-2 grid gap-2">
            {(Object.keys(MODE_META) as PortfolioMode[]).map((k) => {
              const m = MODE_META[k];
              const Icon = m.icon;
              const active = mode === k;
              const isReal = k === "live_prod";
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setMode(k)}
                  className={
                    "flex items-start gap-3 rounded-md border p-3 text-left transition-colors " +
                    (active
                      ? isReal
                        ? "border-destructive/70 bg-destructive/10"
                        : "border-primary bg-primary/10"
                      : "border-border hover:bg-muted/50")
                  }
                >
                  <Icon
                    className={
                      "mt-0.5 h-4 w-4 shrink-0 " +
                      (isReal ? "text-destructive" : active ? "text-primary" : "text-muted-foreground")
                    }
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{m.label}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{m.blurb}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {isLive && (
          <div className="rounded-md border border-border p-3 text-xs">
            <div className="mb-1 font-medium">Saxo {meta.targetEnv?.toUpperCase()} connection</div>
            {saxoQ.isLoading ? (
              <span className="text-muted-foreground">Checking…</span>
            ) : !saxoReady ? (
              <div className="space-y-2">
                <span className="text-destructive">
                  Not connected. You must link your Saxo {meta.targetEnv?.toUpperCase()} account before creating this portfolio.
                </span>
                <Link to="/saxo-status" className="inline-flex items-center gap-1 text-primary hover:underline">
                  Open Saxo connection page <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                <span className="text-emerald-600 dark:text-emerald-400">
                  ✓ Connected to Saxo {meta.targetEnv?.toUpperCase()}
                </span>
                <BrokerBalancePreview
                  env={meta.targetEnv === "prod" ? "live" : "sim"}
                  isRealMoney={mode === "live_prod"}
                  data={balQ.data}
                  isLoading={balQ.isLoading}
                  isFetching={balQ.isFetching}
                  error={balQ.error instanceof Error ? balQ.error.message : balQ.error ? String(balQ.error) : null}
                  onRefresh={() => balQ.refetch()}
                  fmt={fmtMoney}
                />
              </div>
            )}
          </div>
        )}

        {mode === "live_prod" && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Real money — read this</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>Once created, the AI will place real orders on your Saxo LIVE account every hour. Cash-only, no leverage. You can pause or revert to paper at any time from the portfolio page.</p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={ackRisk} onCheckedChange={(v) => setAckRisk(v === true)} />
                <span>I understand this trades real money and I accept the risks.</span>
              </label>
            </AlertDescription>
          </Alert>
        )}

        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-[1fr_100px] gap-2">
          <div>
            <Label htmlFor="cash">
              <Explain term="starting_pot">Starting pot</Explain>
              {isLive && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">(overridden by Saxo balance)</span>
              )}
            </Label>
            <Input
              id="cash"
              type="number"
              min={10}
              max={1_000_000}
              value={cash}
              disabled={isLive}
              onChange={(e) => setCash(Math.max(10, Number(e.target.value) || 0))}
            />
          </div>
          <div>
            <Label>Currency</Label>
            <Select value={currency} onValueChange={(v) => setCurrency(v as typeof currency)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="GBP">GBP</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="EUR">EUR</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label><Explain term="risk_level">Risk level</Explain></Label>
          <div className="mt-2 space-y-2">
            <Slider
              value={[risk === "conservative" ? 0 : risk === "balanced" ? 1 : 2]}
              onValueChange={([v]) => setRisk(v === 0 ? "conservative" : v === 1 ? "balanced" : "aggressive")}
              min={0}
              max={2}
              step={1}
            />
            <p className="text-xs text-muted-foreground">{RISK_LABELS[risk]}</p>
          </div>
        </div>
        <div>
          <Label><Explain term="universe">Asset universe</Explain></Label>
          <div className="mt-2 space-y-2">
            {Object.entries(CLASS_LABELS).map(([c, label]) => (
              <label key={c} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={classes.includes(c)}
                  onCheckedChange={() => toggleClass(c)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
        <Button
          className="w-full"
          variant={mode === "live_prod" ? "destructive" : "default"}
          disabled={disabled}
          onClick={onSubmit}
        >
          {mut.isPending ? "Creating…" : meta.cta}
        </Button>
      </CardContent>
    </Card>
  );
}

function BrokerBalancePreview(props: {
  env: "sim" | "live";
  isRealMoney: boolean;
  data:
    | {
        env: "sim" | "live";
        accountId: string | null;
        currency: string;
        cash: number;
        cashAvailable: number | null;
        transactionsNotBooked: number | null;
        reservedCash: number | null;
        unrealizedPnl: number | null;
        positionsValue: number;
        totalValue: number;
        positionsCount: number;
        fetchedAt: string;
      }
    | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  onRefresh: () => void;
  fmt: (n: number, ccy: string) => string;
}) {
  const { data, isLoading, isFetching, error, onRefresh, fmt, isRealMoney, env } = props;
  const emphasis = isRealMoney
    ? "border-destructive/40 bg-destructive/5"
    : "border-border bg-muted/30";
  // The starting pot is the immediately-available cash when Saxo reports it;
  // otherwise fall back to the raw CashBalance.
  const startingPot = data
    ? data.cashAvailable != null
      ? data.cashAvailable
      : data.cash
    : 0;
  const headline = data ? fmt(startingPot, data.currency) : "—";
  const pending = data?.transactionsNotBooked ?? 0;
  const reserved = data?.reservedCash ?? 0;

  // Flash a "Just updated" state briefly after each successful refresh, so the
  // user gets an unambiguous success signal instead of just the spinner ending.
  const [justUpdated, setJustUpdated] = useState(false);
  useEffect(() => {
    if (!data?.fetchedAt) return;
    setJustUpdated(true);
    const t = setTimeout(() => setJustUpdated(false), 2000);
    return () => clearTimeout(t);
  }, [data?.fetchedAt]);

  // Classify the failure so we can show the right recovery UI. Auth-type
  // errors need the user to reconnect Saxo; everything else is treated as a
  // transient outage we can retry against.
  const errLower = (error ?? "").toLowerCase();
  const isAuthError =
    !!error &&
    /401|403|unauthorized|forbidden|token|invalid[_ ]?grant|reauth|expired/.test(
      errLower,
    );
  const isTemporary = !!error && !isAuthError;

  const buttonState: "idle" | "loading" | "success" | "error" = isFetching
    ? "loading"
    : error
      ? "error"
      : justUpdated
        ? "success"
        : "idle";

  return (
    <div
      className={`rounded-md border p-3 ${emphasis}`}
      role="status"
      aria-live="polite"
      aria-busy={isFetching}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Starting cash from Saxo {env.toUpperCase()}
          </div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">
            {isLoading
              ? "Loading…"
              : error && !data
                ? "Unavailable"
                : headline}
          </div>
          {data && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>
                Account {data.accountId ?? "—"} · fetched{" "}
                {new Date(data.fetchedAt).toLocaleTimeString()}
              </span>
              {justUpdated && (
                <span className="inline-flex items-center gap-1 rounded-sm bg-emerald-500/15 px-1 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-2.5 w-2.5" /> Just updated
                </span>
              )}
              {error && data && (
                <span className="inline-flex items-center gap-1 rounded-sm bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-2.5 w-2.5" /> Stale
                </span>
              )}
            </div>
          )}
        </div>
        <Button
          type="button"
          variant={buttonState === "error" ? "destructive" : "outline"}
          size="sm"
          onClick={onRefresh}
          disabled={isFetching}
          className="h-7 gap-1 px-2 text-[11px]"
          aria-label={
            buttonState === "loading"
              ? "Refreshing balance"
              : buttonState === "error"
                ? "Retry balance refresh"
                : "Refresh balance"
          }
        >
          {buttonState === "loading" ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> Refreshing…
            </>
          ) : buttonState === "success" ? (
            <>
              <CheckCircle2 className="h-3 w-3" /> Updated
            </>
          ) : buttonState === "error" ? (
            <>
              <RefreshCw className="h-3 w-3" /> Retry
            </>
          ) : (
            <>
              <RefreshCw className="h-3 w-3" /> Refresh
            </>
          )}
        </Button>
      </div>

      {error && (
        <div
          className={`mt-2 flex items-start gap-2 rounded border p-2 text-[11px] ${
            isAuthError
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          }`}
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 space-y-1.5">
            <div className="font-medium">
              {isAuthError
                ? `Saxo ${env.toUpperCase()} needs to be reconnected`
                : `Saxo ${env.toUpperCase()} is temporarily unavailable`}
            </div>
            <div className="break-words opacity-90">{error}</div>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {isTemporary && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRefresh}
                  disabled={isFetching}
                  className="h-6 gap-1 px-2 text-[11px]"
                >
                  {isFetching ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Try again
                </Button>
              )}
              {isAuthError && (
                <Link
                  to="/saxo-status"
                  className="inline-flex items-center gap-1 rounded-sm border border-destructive/40 bg-background px-2 py-0.5 font-medium text-destructive hover:bg-destructive/10"
                >
                  Reconnect Saxo <ExternalLink className="h-3 w-3" />
                </Link>
              )}
              {data && (
                <span className="text-[10px] opacity-80">
                  Showing last known balance from{" "}
                  {new Date(data.fetchedAt).toLocaleTimeString()}.
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {data && (
        <div className="mt-3 space-y-2 text-[11px]">
          <div className="rounded border border-border/60 bg-background/40 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Cash breakdown
            </div>
            <div className="space-y-1">
              <Row
                label="Available / settled"
                hint="Free to trade right now — this is your starting pot"
                value={fmt(data.cashAvailable ?? data.cash, data.currency)}
                emphasise
              />
              {data.cashAvailable != null && (
                <Row
                  label="Reserved (open orders / margin)"
                  hint="Held against working orders or collateral — not usable"
                  value={fmt(reserved, data.currency)}
                  muted={reserved === 0}
                />
              )}
              <Row
                label="Pending / unsettled"
                hint="Booked transactions still settling (typically T+2)"
                value={fmt(pending, data.currency)}
                muted={pending === 0}
              />
              <div className="flex items-center justify-between border-t border-border/60 pt-1">
                <span className="text-muted-foreground">Total cash on account</span>
                <span className="font-medium tabular-nums">
                  {fmt(data.cash, data.currency)}
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                Existing positions ({data.positionsCount})
              </span>
              <span className="tabular-nums">
                {fmt(data.positionsValue, data.currency)}
              </span>
            </div>
            {data.unrealizedPnl != null && data.unrealizedPnl !== 0 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Unrealised P&amp;L</span>
                <span
                  className={`tabular-nums ${
                    data.unrealizedPnl >= 0 ? "text-emerald-500" : "text-destructive"
                  }`}
                >
                  {fmt(data.unrealizedPnl, data.currency)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-border/60 pt-1">
              <span className="text-muted-foreground">Total account value</span>
              <span className="tabular-nums">{fmt(data.totalValue, data.currency)}</span>
            </div>
          </div>

          <p className="pt-1 text-muted-foreground">
            Only the <span className="font-medium">available / settled</span> cash
            becomes this portfolio&apos;s starting pot
            {data.cashAvailable == null && data.transactionsNotBooked == null
              ? " (Saxo didn't report a settled breakdown for this account, so the full cash balance is used)"
              : ""}
            . Existing positions on your Saxo {env.toUpperCase()} account are left
            untouched — Aegis will not sell them.
          </p>
        </div>
      )}
    </div>
  );
}

function Row(props: {
  label: string;
  hint?: string;
  value: string;
  emphasise?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div
          className={
            props.emphasise
              ? "font-medium"
              : props.muted
                ? "text-muted-foreground"
                : ""
          }
        >
          {props.label}
        </div>
        {props.hint && (
          <div className="text-[10px] text-muted-foreground">{props.hint}</div>
        )}
      </div>
      <span
        className={`tabular-nums ${props.emphasise ? "font-semibold" : ""} ${
          props.muted ? "text-muted-foreground" : ""
        }`}
      >
        {props.value}
      </span>
    </div>
  );
}


