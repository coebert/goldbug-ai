import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLD_HOURS,
  alertKey,
  dueDeadlineAlerts,
  hoursUntil,
  normalizeThresholds,
  type DeadlineAlertEvent,
} from "@/lib/corporate-action-deadline-alerts";

const NOW = new Date("2026-07-31T12:00:00Z");

function ev(patch: Partial<DeadlineAlertEvent> = {}): DeadlineAlertEvent {
  return {
    id: "ca-1",
    instrument: "Unilever PLC",
    symbol: "ULVR:xlon",
    eventTypeLabel: "Dividend reinvestment",
    deadline: "2026-08-02T12:00:00Z", // 48h out
    requiresElection: true,
    ...patch,
  };
}

describe("normalizeThresholds", () => {
  it("falls back to the default ladder", () => {
    expect(normalizeThresholds([])).toEqual([...DEFAULT_THRESHOLD_HOURS]);
    expect(normalizeThresholds(null)).toEqual([...DEFAULT_THRESHOLD_HOURS]);
  });

  it("dedupes, sorts descending and drops out-of-range values", () => {
    expect(normalizeThresholds([4, 24, 24, 0, 5000, 72])).toEqual([72, 24, 4]);
  });

  it("caps the ladder at five steps", () => {
    expect(normalizeThresholds([1, 2, 3, 4, 5, 6, 7])).toHaveLength(5);
  });
});

describe("hoursUntil", () => {
  it("returns null for missing or unparseable deadlines", () => {
    expect(hoursUntil(null, NOW)).toBeNull();
    expect(hoursUntil("not-a-date", NOW)).toBeNull();
  });

  it("is negative once the deadline has passed", () => {
    expect(hoursUntil("2026-07-31T09:00:00Z", NOW)).toBeCloseTo(-3);
  });
});

describe("dueDeadlineAlerts", () => {
  const base = { thresholds: [72, 24, 4], now: NOW, alreadySent: new Set<string>() };

  it("fires the tightest crossed threshold and suppresses the wider ones", () => {
    const [alert] = dueDeadlineAlerts({ ...base, events: [ev()] });
    expect(alert.thresholdHours).toBe(72);
    expect(alert.suppressed).toEqual([]);
    expect(alert.hoursRemaining).toBeCloseTo(48);
  });

  it("only pushes the closest step when several are crossed at once", () => {
    const [alert] = dueDeadlineAlerts({
      ...base,
      events: [ev({ deadline: "2026-07-31T14:00:00Z" })], // 2h out
    });
    expect(alert.thresholdHours).toBe(4);
    expect(alert.suppressed).toEqual([24, 72]);
    expect(alert.title).toContain("2h left");
  });

  it("does not repeat a threshold that already fired", () => {
    const sent = new Set([alertKey("ca-1", 72)]);
    expect(dueDeadlineAlerts({ ...base, events: [ev()], alreadySent: sent })).toEqual([]);
  });

  it("still fires the next step down after the first one was sent", () => {
    const sent = new Set([alertKey("ca-1", 72)]);
    const [alert] = dueDeadlineAlerts({
      ...base,
      alreadySent: sent,
      events: [ev({ deadline: "2026-08-01T00:00:00Z" })], // 12h out
    });
    expect(alert.thresholdHours).toBe(24);
    expect(alert.suppressed).toEqual([]);
  });

  it("ignores passed deadlines, missing deadlines and no-election events", () => {
    expect(
      dueDeadlineAlerts({
        ...base,
        events: [
          ev({ id: "a", deadline: "2026-07-30T12:00:00Z" }),
          ev({ id: "b", deadline: null }),
          ev({ id: "c", requiresElection: false }),
        ],
      }),
    ).toEqual([]);
  });

  it("does not fire before the widest threshold is reached", () => {
    expect(
      dueDeadlineAlerts({ ...base, events: [ev({ deadline: "2026-08-10T12:00:00Z" })] }),
    ).toEqual([]);
  });

  it("orders a batch most-urgent first and tags uniquely", () => {
    const alerts = dueDeadlineAlerts({
      ...base,
      events: [
        ev({ id: "far", deadline: "2026-08-02T12:00:00Z" }),
        ev({ id: "near", deadline: "2026-07-31T13:00:00Z" }),
      ],
    });
    expect(alerts.map((a) => a.eventId)).toEqual(["near", "far"]);
    expect(new Set(alerts.map((a) => a.tag)).size).toBe(2);
  });

  it("is idempotent when the caller records every emitted key", () => {
    const sent = new Set<string>();
    const first = dueDeadlineAlerts({ ...base, events: [ev()], alreadySent: sent });
    for (const a of first) {
      sent.add(alertKey(a.eventId, a.thresholdHours));
      a.suppressed.forEach((t) => sent.add(alertKey(a.eventId, t)));
    }
    expect(dueDeadlineAlerts({ ...base, events: [ev()], alreadySent: sent })).toEqual([]);
  });

  it("includes the portfolio name in the body when supplied", () => {
    const [alert] = dueDeadlineAlerts({ ...base, events: [ev()], portfolioName: "Live Cash" });
    expect(alert.body).toContain("Live Cash");
  });

  it("uses minutes in the label inside the final hour", () => {
    const [alert] = dueDeadlineAlerts({
      ...base,
      events: [ev({ deadline: "2026-07-31T12:30:00Z" })],
    });
    expect(alert.title).toContain("30 min left");
  });
});
