import { ReferenceArea, ReferenceLine } from "recharts";
import { clipToDomain, eventColor, eventsInRange, type GlobalEvent } from "@/lib/global-events";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Info } from "lucide-react";

type Props = {
  domainDates: string[]; // sorted ascending ISO dates that exist on the x-axis
  yAxisId?: string;
  minSeverity?: 1 | 2 | 3;
  labelPosition?: "insideTop" | "insideTopRight" | "insideBottomRight";
};

/** Render <ReferenceArea>/<ReferenceLine> children INSIDE a recharts chart. */
export function EventOverlay({ domainDates, yAxisId, minSeverity = 2, labelPosition = "insideTopRight" }: Props) {
  if (!domainDates?.length) return null;
  const first = domainDates[0];
  const last = domainDates[domainDates.length - 1];
  const events = eventsInRange(first, last).filter((e) => e.severity >= minSeverity);
  return (
    <>
      {events.map((e) => {
        const clip = clipToDomain(e, domainDates);
        if (!clip) return null;
        const color = eventColor(e.category);
        const single = clip.x1 === clip.x2;
        if (single) {
          return (
            <ReferenceLine
              key={e.id}
              x={clip.x1}
              stroke={color}
              strokeDasharray="3 3"
              yAxisId={yAxisId as never}
              ifOverflow="extendDomain"
              label={{ value: e.short, position: labelPosition, fill: color, fontSize: 10, fontWeight: 600 }}
            />
          );
        }
        return (
          <ReferenceArea
            key={e.id}
            x1={clip.x1}
            x2={clip.x2}
            yAxisId={yAxisId as never}
            fill={color}
            fillOpacity={0.09}
            stroke={color}
            strokeOpacity={0.35}
            strokeDasharray="2 3"
            ifOverflow="extendDomain"
            label={{ value: e.short, position: labelPosition, fill: color, fontSize: 10, fontWeight: 600 }}
          />
        );
      })}
    </>
  );
}

/** Small legend/toggle chip strip shown above a chart. */
export function EventOverlayControls({
  domainDates,
  enabled,
  onToggle,
  minSeverity,
  onSeverityChange,
}: {
  domainDates: string[];
  enabled: boolean;
  onToggle: (v: boolean) => void;
  minSeverity: 1 | 2 | 3;
  onSeverityChange: (s: 1 | 2 | 3) => void;
}) {
  const [showList, setShowList] = useState(false);
  if (!domainDates?.length) return null;
  const first = domainDates[0];
  const last = domainDates[domainDates.length - 1];
  const events = eventsInRange(first, last).filter((e) => e.severity >= minSeverity);
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <div className="flex items-center gap-2">
        <Switch id="event-overlay-toggle" checked={enabled} onCheckedChange={onToggle} />
        <Label htmlFor="event-overlay-toggle" className="cursor-pointer">
          Overlay events
        </Label>
      </div>
      {enabled && (
        <>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span>Severity ≥</span>
            {[1, 2, 3].map((s) => (
              <button
                key={s}
                onClick={() => onSeverityChange(s as 1 | 2 | 3)}
                className={`rounded px-1.5 py-0.5 tabular-nums ${
                  minSeverity === s ? "bg-primary/20 text-primary" : "hover:bg-muted"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowList((v) => !v)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <Info className="h-3 w-3" />
            {events.length} event{events.length === 1 ? "" : "s"} in window
          </button>
        </>
      )}
      {enabled && showList && (
        <div className="mt-1 flex w-full flex-wrap gap-1">
          {events.map((e) => (
            <EventChip key={e.id} event={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventChip({ event }: { event: GlobalEvent }) {
  const color = eventColor(event.category);
  return (
    <Badge
      variant="outline"
      className="gap-1 border-transparent"
      style={{ background: `${color}18`, color, borderColor: `${color}55` }}
      title={`${event.label} · ${event.start}${event.start === event.end ? "" : ` → ${event.end}`}\n${event.note}`}
    >
      <span className="font-mono text-[10px]">{event.short}</span>
      <span className="truncate max-w-[10rem]">{event.label}</span>
    </Badge>
  );
}
