import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent } from "@/components/ui/card";
import { GLOSSARY, LEARN_GROUPS } from "@/lib/glossary";
import { BookOpen } from "lucide-react";

export const Route = createFileRoute("/learn")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Learn the basics — Aegis" },
      {
        name: "description",
        content:
          "Plain-English explanations of every trading term and metric used in Aegis.",
      },
    ],
  }),
  component: LearnPage,
});

function LearnPage() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);

  return (
    <div className="min-h-dvh">
      <AppHeader email={email} />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-8">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <BookOpen className="h-3.5 w-3.5" /> Beginner-friendly
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Learn the basics</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Every term used in Aegis, explained in plain English. Anything with a dotted
            underline anywhere in the app opens the same short explanation you'll find here.
            You do not need any previous trading experience.
          </p>
        </div>

        <section
          aria-labelledby="tour-heading"
          className="mb-10 rounded-xl border border-primary/40 bg-primary/5 p-4 sm:p-6"
        >
          <h2
            id="tour-heading"
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            5-minute tour
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The shortest possible path from "what is this?" to a live simulated portfolio.
          </p>
          <ol className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              {
                n: 1,
                title: "Create a demo portfolio",
                body: "On Home, tap New portfolio. Pick a name, keep Money type on Simulated cash, and set a risk level. No broker connection needed.",
              },
              {
                n: 2,
                title: "Watch the hourly loop",
                body: "Aegis reads market prices and global headlines every hour. Each decision shows which signals and news items drove it.",
              },
              {
                n: 3,
                title: "Adjust risk anytime",
                body: "Use the low-to-high risk slider on the portfolio page. Advanced fine-tuning lives behind a Fine-tune toggle.",
              },
              {
                n: 4,
                title: "Compare & review",
                body: "Compare overlays portfolios across time ranges. Reports export a plain-English summary of every trade.",
              },
              {
                n: 5,
                title: "Go real when ready",
                body: "Only when you're comfortable, connect Saxo on the Broker page and create a live_prod portfolio. Everything can stay paper-traded via the LIVE_SIM_PAPER_ONLY switch.",
              },
            ].map((s) => (
              <li key={s.n} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-xs text-primary">
                    {s.n}
                  </span>
                  {s.title}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">
            Prefer to skim first? Every trading term below is explained in one short paragraph.
          </p>
        </section>



        <nav aria-label="Section jump links" className="mb-8 flex flex-wrap gap-2">
          {LEARN_GROUPS.map((g) => (
            <a
              key={g.heading}
              href={`#group-${g.heading.replace(/\s+/g, "-").toLowerCase()}`}
              className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {g.heading}
            </a>
          ))}
        </nav>

        <div className="space-y-10">
          {LEARN_GROUPS.map((group) => (
            <section
              key={group.heading}
              id={`group-${group.heading.replace(/\s+/g, "-").toLowerCase()}`}
              aria-labelledby={`h-${group.heading.replace(/\s+/g, "-").toLowerCase()}`}
            >
              <h2
                id={`h-${group.heading.replace(/\s+/g, "-").toLowerCase()}`}
                className="mb-3 text-lg font-semibold tracking-tight"
              >
                {group.heading}
              </h2>
              <div className="space-y-3">
                {group.terms.map((termId) => {
                  const e = GLOSSARY[termId];
                  return (
                    <Card key={termId} id={termId} className="scroll-mt-24">
                      <CardContent className="space-y-2 py-4">
                        <div className="text-base font-semibold">{e.title}</div>
                        <p className="text-sm text-muted-foreground">{e.short}</p>
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Why it matters: </span>
                          {e.why}
                        </p>
                        {e.rule && (
                          <p className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Rule of thumb: </span>
                            {e.rule}
                          </p>
                        )}
                        {e.example && (
                          <p className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Example: </span>
                            {e.example}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-12 rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          Still stuck on something? Every underlined term in the app opens a mini version of
          this page focused on just that one idea.{" "}
          <Link to="/" className="font-medium text-primary hover:underline">
            Back to your portfolios →
          </Link>
        </div>
      </main>
    </div>
  );
}
