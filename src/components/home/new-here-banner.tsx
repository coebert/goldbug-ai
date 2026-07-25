import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { BookOpen, X } from "lucide-react";

export function NewHereBanner() {
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
        aria-label="Dismiss new-here banner"
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
