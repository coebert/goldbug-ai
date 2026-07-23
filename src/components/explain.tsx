// Click-to-explain primitive. Wrap any jargon term in <Explain term="sharpe">Sharpe</Explain>
// or drop <ExplainIcon term="sharpe" /> next to a label. Works on click, keyboard, and tap.

import { Link } from "@tanstack/react-router";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GLOSSARY, type TermId } from "@/lib/glossary";

function Body({ term }: { term: TermId }) {
  const entry = GLOSSARY[term];
  if (!entry) return null;
  return (
    <div className="space-y-2 text-sm">
      <div className="text-sm font-semibold text-foreground">{entry.title}</div>
      <p className="text-muted-foreground">{entry.short}</p>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Why it matters: </span>
        {entry.why}
      </p>
      {entry.rule && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Rule of thumb: </span>
          {entry.rule}
        </p>
      )}
      {entry.example && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Example: </span>
          {entry.example}
        </p>
      )}
      <Link
        to="/learn"
        hash={term}
        className="inline-block text-xs font-medium text-primary hover:underline"
      >
        Read more →
      </Link>
    </div>
  );
}

interface ExplainProps {
  term: TermId;
  children: ReactNode;
  className?: string;
}

export function Explain({ term, children, className = "" }: ExplainProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Explain: ${GLOSSARY[term]?.title ?? term}`}
          className={`cursor-help border-b border-dotted border-muted-foreground/60 text-left hover:border-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded-sm ${className}`}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)]" align="start">
        <Body term={term} />
      </PopoverContent>
    </Popover>
  );
}

export function ExplainIcon({ term, className = "" }: { term: TermId; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Explain: ${GLOSSARY[term]?.title ?? term}`}
          className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${className}`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)]" align="start">
        <Body term={term} />
      </PopoverContent>
    </Popover>
  );
}
