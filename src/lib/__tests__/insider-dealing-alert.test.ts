import { describe, it, expect, vi } from "vitest";
import {
  insiderEventKey,
  insiderAlertSeverity,
  insiderAlertText,
  formatInsiderBlock,
  type InsiderDealingEvent,
} from "@/lib/insider-dealings";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/push.server", () => ({ sendPushToUser: vi.fn(async () => ({ sent: 1 })) }));

const ev = (over: Partial<InsiderDealingEvent> = {}): InsiderDealingEvent =>
  ({
    symbol: "MKS.L",
    company: "Marks & Spencer",
    event_date: "2026-08-12",
    headline: "M&S chief executive sells 500,000 shares",
    summary: null,
    source: "rns",
    url: null,
    direction: "sell",
    flavour: "discretionary",
    person: "Stuart Machin",
    role: "CEO",
    shares: 500_000,
    value: 1_900_000,
    severity: 0.8,
    sentiment_nudge: -0.12,
    ...over,
  }) as InsiderDealingEvent;

describe("insider alert primitives", () => {
  it("keys are stable across whitespace/case noise", () => {
    expect(insiderEventKey(ev())).toBe(
      insiderEventKey(ev({ headline: "  M&S Chief Executive  Sells 500,000 Shares " })),
    );
  });

  it("keys differ per symbol and date", () => {
    expect(insiderEventKey(ev())).not.toBe(insiderEventKey(ev({ event_date: "2026-08-11" })));
    expect(insiderEventKey(ev())).not.toBe(insiderEventKey(ev({ symbol: "TSCO.L" })));
  });

  it("mechanical disposals stay informational, discretionary ones escalate", () => {
    expect(insiderAlertSeverity(ev({ flavour: "tax", severity: 0.2 }))).toBe("info");
    expect(insiderAlertSeverity(ev())).not.toBe("info");
  });

  it("alert copy names the symbol and the person", () => {
    const { title, body } = insiderAlertText(ev());
    expect(title).toContain("MKS.L");
    expect(`${title} ${body}`).toContain("Machin");
  });
});

describe("formatInsiderBlock", () => {
  it("says none when there is nothing to report", () => {
    expect(formatInsiderBlock([])).toContain("none reported");
  });

  it("lists the worst dealing per symbol with its nudge", () => {
    const block = formatInsiderBlock([
      { symbol: "MKS.L", nudge: -0.12, events: 2, worst: ev() },
    ]);
    expect(block).toContain("MKS.L");
    expect(block).toContain("-0.120");
    expect(block).toContain("2 report(s)");
  });
});

describe("alertInsiderDisposals", () => {
  function makeSb(existing: unknown[] = []) {
    const inserted: Record<string, unknown>[] = [];
    const sb = {
      from(table: string) {
        if (table === "holdings") {
          return {
            select: () => ({
              limit: async () => ({
                data: [
                  {
                    symbol: "MKS:xlon",
                    quantity: 100,
                    portfolio_id: "p1",
                    portfolios: { user_id: "u1" },
                  },
                ],
              }),
            }),
          };
        }
        // notifications
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        Object.assign(chain, {
          select: self,
          eq: self,
          contains: self,
          is: self,
          gte: self,
          order: self,
          limit: async () => ({ data: existing }),
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: null };
          },
        });
        return chain;
      },
    };
    return { sb, inserted };
  }

  it("fires once for a held symbol and stays silent on replay", async () => {
    const { alertInsiderDisposals } = await import("@/lib/insider-dealing-alert.server");
    const { sb, inserted } = makeSb();
    const first = await alertInsiderDisposals([ev()], { supabase: sb as never });
    expect(first.considered).toBe(1);
    expect(first.sent).toBe(1);
    expect(inserted[0]?.["category"]).toBe("insider_dealing");

    const key = insiderEventKey(ev());
    const { sb: sb2 } = makeSb([{ id: "n1", details: { event_key: key } }]);
    const second = await alertInsiderDisposals([ev()], { supabase: sb2 as never });
    expect(second.sent).toBe(0);
  });

  it("ignores buys and unheld symbols", async () => {
    const { alertInsiderDisposals } = await import("@/lib/insider-dealing-alert.server");
    const { sb } = makeSb();
    const buy = await alertInsiderDisposals([ev({ direction: "buy" })], { supabase: sb as never });
    expect(buy.sent).toBe(0);

    const { sb: sb2 } = makeSb();
    const other = await alertInsiderDisposals([ev({ symbol: "TSCO.L" })], {
      supabase: sb2 as never,
    });
    expect(other.sent).toBe(0);
  });
});
