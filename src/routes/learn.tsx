import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { GLOSSARY, LEARN_GROUPS, type GlossaryEntry } from "@/lib/glossary";
import { BookOpen, Search, X } from "lucide-react";

export const Route = createFileRoute("/learn")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Learn the basics — Aegis" },
      {
        name: "description",
        content:
          "Search plain-English explanations of every trading term and metric used in Aegis.",
      },
    ],
  }),
  component: LearnPage,
});

type SearchHit = {
  termId: string;
  entry: GlossaryEntry;
  group: string;
  score: number;
};

function scoreEntry(q: string, termId: string, e: GlossaryEntry): number {
  const needle = q.toLowerCase();
  const title = e.title.toLowerCase();
  const id = termId.toLowerCase();
  if (title === needle || id === needle) return 100;
  if (title.startsWith(needle) || id.startsWith(needle)) return 80;
  if (title.includes(needle) || id.includes(needle)) return 60;
  const hay = `${e.short} ${e.why} ${e.rule ?? ""} ${e.example ?? ""}`.toLowerCase();
  if (hay.includes(needle)) return 20;
  return 0;
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-primary/25 px-0.5 text-foreground">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function LearnPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
  }, []);

  // Focus search on "/" and scroll to hash on mount / hash change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const scrollToHash = () => {
      const h = window.location.hash.replace(/^#/, "");
      if (!h) return;
      const el = document.getElementById(h);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("ring-2", "ring-primary/60");
        window.setTimeout(() => el.classList.remove("ring-2", "ring-primary/60"), 1600);
      }
    };
    scrollToHash();
    window.addEventListener("hashchange", scrollToHash);
    return () => window.removeEventListener("hashchange", scrollToHash);
  }, []);

  const groupByTerm = useMemo(() => {
    const map: Record<string, string> = {};
    for (const g of LEARN_GROUPS) for (const t of g.terms) map[t] = g.heading;
    return map;
  }, []);

  const hits: SearchHit[] = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const out: SearchHit[] = [];
    for (const [termId, entry] of Object.entries(GLOSSARY)) {
      const score = scoreEntry(q, termId, entry);
      if (score > 0) {
        out.push({ termId, entry, group: groupByTerm[termId] ?? "Other", score });
      }
    }
    return out.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  }, [query, groupByTerm]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  const jumpToTerm = (termId: string) => {
    // Update hash to trigger scroll effect; the entry cards already have ids.
    if (window.location.hash === `#${termId}`) {
      // Force re-scroll if the hash is already set.
      const el = document.getElementById(termId);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.location.hash = termId;
    }
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!hits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[activeIdx];
      if (hit) jumpToTerm(hit.termId);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  return (
    <div className="min-h-dvh">
      <AppHeader email={email} />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <BookOpen className="h-3.5 w-3.5" /> Beginner-friendly
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Learn the basics</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Every term used in Aegis, explained in plain English. Anything with a dotted
            underline anywhere in the app opens the same short explanation you'll find here.
          </p>
        </div>

        {/* Search */}
        <div className="mb-6">
          <label htmlFor="glossary-search" className="sr-only">
            Search the glossary
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="glossary-search"
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="Search terms (Sharpe, RSI, drawdown…) — press / to focus"
              className="pl-9 pr-10"
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-controls="glossary-results"
              aria-autocomplete="list"
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {query
              ? `${hits.length} match${hits.length === 1 ? "" : "es"} — use ↑ ↓ to navigate, Enter to jump.`
              : `${Object.keys(GLOSSARY).length} terms available. Tip: press / to focus the search.`}
          </p>

          {query && hits.length > 0 && (
            <ul
              id="glossary-results"
              role="listbox"
              className="mt-3 max-h-80 overflow-auto rounded-lg border border-border bg-popover p-1 shadow-sm"
            >
              {hits.slice(0, 20).map((h, i) => (
                <li key={h.termId} role="option" aria-selected={i === activeIdx}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => jumpToTerm(h.termId)}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm ${
                      i === activeIdx ? "bg-muted text-foreground" : "hover:bg-muted/60"
                    }`}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="font-medium">{highlight(h.entry.title, query)}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {h.group}
                      </span>
                    </span>
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {highlight(h.entry.short, query)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {query && hits.length === 0 && (
            <div className="mt-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No terms match "{query}". Try a shorter word — e.g. "risk", "vol", or "stop".
            </div>
          )}
        </div>

        {!query && (
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
          </section>
        )}

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
                    <Card
                      key={termId}
                      id={termId}
                      className="scroll-mt-24 transition-shadow"
                    >
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
