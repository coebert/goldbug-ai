import { Gauge, LayoutGrid, Layers } from "lucide-react";
import { useExperienceLevel } from "@/lib/use-experience-level";

/**
 * Simple / Advanced switch. This is the app's main density control:
 * "Simple" keeps only the panels a newcomer needs on screen, "Advanced"
 * restores the full analytics surface. Nothing is ever removed — the
 * advanced panels just collapse.
 */
export function ExperienceLevelToggle({ className = "" }: { className?: string }) {
  const [level, setLevel] = useExperienceLevel();

  return (
    <div
      role="radiogroup"
      aria-label="How much detail to show"
      className={`inline-flex items-center rounded-full border border-border/70 bg-surface-sunken p-0.5 ${className}`}
    >
      {(
        [
          { value: "simple", label: "Simple", Icon: Gauge, hint: "Just the essentials" },
          { value: "standard", label: "Standard", Icon: LayoutGrid, hint: "Essentials plus today's detail" },
          { value: "advanced", label: "Everything", Icon: Layers, hint: "Every analytics panel" },
        ] as const
      ).map(({ value, label, Icon, hint }) => {
        const active = level === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={hint}
            onClick={() => setLevel(value)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-2.5 text-xs sm:px-2.5 sm:py-1 font-medium transition-colors ${
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
