import { cn } from "@/lib/utils";

type SkeletonProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * Visual variant.
   * - "pulse" (default): legacy shadcn look, `animate-pulse` on a muted block.
   * - "shimmer": a moving highlight sweep. Use for value slots where the
   *   final rendered content has strong typographic presence (large
   *   numbers, headlines) so the loading state visibly matches the
   *   final layout box and telegraphs "value inbound".
   *
   * Both variants respect `prefers-reduced-motion`.
   */
  variant?: "pulse" | "shimmer";
};

function Skeleton({ className, variant = "pulse", ...props }: SkeletonProps) {
  return (
    <div
      data-variant={variant}
      className={cn(
        variant === "shimmer"
          ? "skeleton-shimmer"
          : "animate-pulse rounded-md bg-primary/10",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
