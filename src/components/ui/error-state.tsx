import * as React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Phase 4 — destructive-tinted panel used inside SectionCardBody when
 * the underlying fetch failed. Mirrors the PortfolioRow error contract
 * so every card responds to failure in the same visual language.
 */
export interface ErrorStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  /** Set true while a retry request is in-flight to disable the button. */
  retrying?: boolean;
}

export function ErrorState({
  title = "Couldn't load this section",
  description,
  onRetry,
  retryLabel = "Retry",
  retrying,
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2 text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        <span className="font-medium">{title}</span>
      </div>
      {description ? (
        <div className="text-xs text-muted-foreground sm:text-sm">
          {description}
        </div>
      ) : null}
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
          className="mt-1"
        >
          <RefreshCw
            className={cn("mr-1.5 h-3.5 w-3.5", retrying && "animate-spin")}
            aria-hidden
          />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
