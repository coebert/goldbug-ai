// Integration test: the corporate-actions panel against mocked Saxo payloads.
//
// Raw Saxo /ca rows go through the same normalisation + impact pipeline the
// server function uses, the result is seeded into the React Query cache, and
// the real <CorporateActionsCard/> is server-rendered. Asserts:
//   1. election options render with their labels, detail and the
//      "applied if you do nothing" default marker;
//   2. the cash-vs-scrip impact preview appears when a position is held;
//   3. the one-click Saxo election deep link is scoped to the right
//      environment / account / event;
//   4. graceful fallbacks — unlinked portfolio, unsupported environment,
//      no pending events, mandatory events with no options, and events with
//      no published deadline — degrade to copy instead of crashing.

import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeCorporateActions, sortByDeadline } from "@/lib/corporate-actions";
import { buildImpactPreview } from "@/lib/corporate-action-impact";
import type {
  CorporateActionView,
  CorporateActionsResult,
} from "@/lib/corporate-actions.functions";

// Server functions never run here: the query cache is pre-seeded.
vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => async () => {
    throw new Error("server fn should not be called — cache is seeded");
  },
}));
vi.mock("@/lib/corporate-actions.functions", async () => ({
  listCorporateActions: { __fn: "listCorporateActions" },
}));

const { CorporateActionsCard } = await import("@/components/corporate-actions-card");

const PORTFOLIO_ID = "11111111-2222-3333-4444-555555555555";
const ACCOUNT_KEY = "acct-live-1";

/** Mocked Saxo corporate-actions rows, in the loose shape the API returns. */
const SAXO_ROWS: unknown[] = [
  {
    EventId: "EV-ULVR-DRIP",
    EventType: "DividendReinvestment",
    AccountKey: ACCOUNT_KEY,
    Uic: 24071,
    DisplayAndFormat: { Description: "Unilever PLC", Symbol: "ULVR:xlon" },
    ExDate: "2026-08-06",
    PayDate: "2026-09-04",
    ResponseDeadline: "2026-08-14T15:00:00Z",
    Status: "Pending",
    ElectiveOptions: [
      {
        OptionNumber: "1",
        OptionName: "Cash dividend",
        OptionType: "Cash",
        Rate: 0.4528,
        CurrencyCode: "GBP",
        IsDefault: true,
      },
      {
        OptionNumber: "2",
        OptionName: "Reinvest in shares",
        OptionType: "Securities",
        Ratio: "1:20",
      },
    ],
  },
  {
    // Mandatory event: no options, no deadline published yet.
    CorporateActionId: "EV-VOD-MERGER",
    EventType: "MergerMandatory",
    AccountKey: ACCOUNT_KEY,
    InstrumentDescription: "Vodafone Group PLC",
    Symbol: "VOD:xlon",
  },
];

function seedResult(patch: Partial<CorporateActionsResult> = {}): CorporateActionsResult {
  const normalized = sortByDeadline(normalizeCorporateActions(SAXO_ROWS));
  const events: CorporateActionView[] = normalized.map(({ raw: _raw, ...view }) => ({
    ...view,
    impact: buildImpactPreview(
      view.options,
      // Only the Unilever line is actually held.
      view.symbol === "ULVR:xlon"
        ? { quantity: 22, price: 46.1, currency: "GBP" }
        : null,
    ),
  }));
  return {
    portfolioId: PORTFOLIO_ID,
    brokerBacked: true,
    supported: true,
    env: "live",
    endpoint: "/ca/v2/events",
    fetchedAt: "2026-07-31T12:00:00Z",
    events,
    reason: null,
    ...patch,
  };
}

function render(result: CorporateActionsResult): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["corporate-actions", PORTFOLIO_ID], result);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CorporateActionsCard portfolioId={PORTFOLIO_ID} />
    </QueryClientProvider>,
  );
}

describe("corporate actions panel — mocked Saxo responses", () => {
  it("renders both events with humanised types and instruments", () => {
    const html = render(seedResult());
    expect(html).toContain("Unilever PLC");
    expect(html).toContain("Vodafone Group PLC");
    expect(html).toContain("Dividend reinvestment");
  });

  it("lists election options with detail and marks the Saxo default", () => {
    const html = render(seedResult());
    expect(html).toContain("Cash dividend");
    expect(html).toContain("Reinvest in shares");
    // Rate + currency and the scrip ratio are surfaced as option detail.
    expect(html).toContain("0.4528 GBP");
    expect(html).toContain("ratio 1:20");
    expect(html).toContain("applied if you do nothing");
  });

  it("shows the cash-vs-scrip impact preview for the held position", () => {
    const html = render(seedResult());
    // 22 shares × 0.4528 ≈ £9.96 cash; scrip is 1 new share per 20 held.
    expect(html).toContain("9.96");
    expect(html).toMatch(/Estimates only/);
  });

  it("deep links each event to the correct Saxo environment and account", () => {
    const html = render(seedResult());
    expect(html).toContain("Make election in Saxo");
    expect(html).toContain("https://www.saxotrader.com/d/corporateactions");
    expect(html).toContain("AccountKey=acct-live-1");
    expect(html).toContain("EventId=EV-ULVR-DRIP");
    expect(html).not.toContain("/sim/d/corporateactions");
  });

  it("uses the simulation workspace when the portfolio is a sim account", () => {
    const html = render(seedResult({ env: "sim" }));
    expect(html).toContain("https://www.saxotrader.com/sim/d/corporateactions");
  });

  it("falls back to copy for mandatory events with no options or deadline", () => {
    const html = render(seedResult());
    expect(html).toContain("No election options published");
    expect(html).toContain("no deadline published");
  });

  it("explains an unlinked portfolio instead of rendering an empty list", () => {
    const html = render(
      seedResult({
        brokerBacked: false,
        supported: false,
        events: [],
        env: null,
        endpoint: null,
        reason: "This portfolio is not linked to a broker account.",
      }),
    );
    expect(html).toContain("not linked to a broker account");
    expect(html).not.toContain("Make election in Saxo");
  });

  it("explains an unsupported Saxo environment", () => {
    const html = render(
      seedResult({
        supported: false,
        events: [],
        reason:
          "Saxo did not expose a corporate-actions endpoint on this environment.",
      }),
    );
    expect(html).toContain("did not expose a corporate-actions endpoint");
  });

  it("shows an all-clear message when there are no pending events", () => {
    const html = render(seedResult({ events: [] }));
    expect(html).toContain("No pending corporate actions on this account.");
  });

  it("survives a malformed Saxo payload without throwing", () => {
    const junk = normalizeCorporateActions([null, 42, { nope: true }]);
    const events: CorporateActionView[] = junk.map(({ raw: _raw, ...v }) => ({
      ...v,
      impact: buildImpactPreview(v.options, null),
    }));
    expect(() => render(seedResult({ events }))).not.toThrow();
  });
});
