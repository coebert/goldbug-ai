import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell } from "lucide-react";
import {
  isCritical,
  sortAlerts,
  type AlertDefinition,
  type AlertSeverity,
} from "@/lib/alerts/registry";

/**
 * One home for banner-style warnings.
 *
 * Callers pass the registry definitions plus a renderer per id. Each
 * banner component returns `null` when it has nothing to say, so the
 * strip watches its slot and only counts the ones that actually
 * produced DOM. It then shows:
 *
 *   - every critical alert, always (trading halts must not hide)
 *   - the highest-priority non-critical alert
 *   - a bell with "N more" opening the rest
 */
export type AlertRender = (id: string) => ReactNode;

function AlertSlot({
  definition,
  hidden,
  onActiveChange,
  children,
}: {
  definition: AlertDefinition;
  hidden: boolean;
  onActiveChange: (id: string, active: boolean) => void;
  children: ReactNode;
}) {
  const active = useRef(false);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const read = () => {
        const next = node.childElementCount > 0;
        if (next !== active.current) {
          active.current = next;
          onActiveChange(definition.id, next);
        }
      };
      read();
      const observer = new MutationObserver(read);
      observer.observe(node, { childList: true, subtree: false });
    },
    [definition.id, onActiveChange],
  );

  return (
    <div
      ref={ref}
      id={`alert-${definition.id}`}
      data-alert={definition.id}
      data-severity={definition.severity}
      className={hidden ? "hidden" : "mb-3"}
    >
      {children}
    </div>
  );
}

const SEVERITY_DOT: Record<AlertSeverity, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  info: "bg-info",
};

export function AlertStrip({
  alerts,
  render,
  className = "",
}: {
  alerts: readonly AlertDefinition[];
  render: AlertRender;
  className?: string;
}) {
  const ordered = useMemo(() => sortAlerts(alerts), [alerts]);
  const [activeIds, setActiveIds] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState(false);

  const handleActive = useCallback((id: string, active: boolean) => {
    setActiveIds((prev) => (prev[id] === active ? prev : { ...prev, [id]: active }));
  }, []);

  const activeNonCritical = ordered.filter((a) => !isCritical(a) && activeIds[a.id]);
  const visibleIds = new Set<string>(ordered.filter(isCritical).map((a) => a.id));
  if (expanded) activeNonCritical.forEach((a) => visibleIds.add(a.id));
  else if (activeNonCritical[0]) visibleIds.add(activeNonCritical[0].id);

  const hiddenCount = expanded ? 0 : Math.max(0, activeNonCritical.length - 1);

  return (
    <div className={className}>
      {ordered.map((definition) => (
        <AlertSlot
          key={definition.id}
          definition={definition}
          hidden={!visibleIds.has(definition.id)}
          onActiveChange={handleActive}
        >
          {render(definition.id)}
        </AlertSlot>
      ))}

      {(hiddenCount > 0 || expanded) && activeNonCritical.length > 1 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mb-4 inline-flex min-h-9 items-center gap-2 rounded-full bg-surface-2 px-3 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
          aria-expanded={expanded}
        >
          <Bell className="h-3.5 w-3.5" aria-hidden />
          {expanded ? "Hide other alerts" : `${hiddenCount} more alert${hiddenCount === 1 ? "" : "s"}`}
          <span className="flex items-center gap-1">
            {activeNonCritical.slice(expanded ? 0 : 1).map((a) => (
              <span
                key={a.id}
                title={a.label}
                className={`h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[a.severity]}`}
              />
            ))}
          </span>
        </button>
      )}
    </div>
  );
}
