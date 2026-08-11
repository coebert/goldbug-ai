// Determinism guard for the "Explain this trade" panel.
//
// The panel's copy is derived (attribution %, confidence wording, calibration
// sentence) — none of it may depend on wall-clock time, Math.random, iteration
// order of the signal-weight object, or query-cache identity. A drift here
// shows up as a flaky snapshot when the suite runs in parallel, so this file
// renders the same inputs repeatedly (and across fresh module state) and
// asserts byte-identical markup.

import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The panel loads calibration through a server fn; tests always pass the
// calibration in directly, so the hook must never fire a request.
vi.mock("@tanstack/react-start", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    self.middleware = () => self;
    self.inputValidator = () => self;
    self.handler = () => self;
    self.server = () => self;
    self.client = () => self;
    return self;
  };
  return {
    createServerFn: () => chain(),
    createMiddleware: () => chain(),
    useServerFn: () => async () => {
      throw new Error("network access is not allowed in determinism tests");
    },
  };
});


import { TradeExplanationPanel } from "@/components/trade-explanation-panel";
import type { AuditEntry } from "@/lib/audit-log";
import { buildCalibration, type CalibrationSample } from "@/lib/confidence-calibration";

const FROZEN_NOW = new Date("2026-03-02T09:30:00.000Z");

const ENTRY: AuditEntry = {
  decisionId: "11111111-1111-4111-8111-111111111111",
  runDate: "2026-02-27",
  orderIndex: 0,
  symbol: "MKS:xlon",
  side: "buy",
  status: "executed",
  quantity: 250,
  price: 3.42,
  value: 855,
  reason: "trend continuation with supportive headlines",
  rejectedReason: null,
  conviction: 0.71,
  signalWeights: { trend_score: 0.6, momentum_20d: 0.25, news_sentiment: 0.3, liquidity: 0.05 },
  ruleTags: ["executed"],
  newsFactors: [
    { headline: "M&S lifts guidance", source: "Reuters", sentiment: 0.4, alignment: "aligned" },
    { headline: "UK retail footfall slips", source: "FT", sentiment: -0.2, alignment: "opposing" },
  ],
  guardrails: { maxPositionPct: 12, risk_level: "balanced" },
  portfolioValue: 10300,
  riskLevel: "balanced",
  smaCross: {
    price: 3.42,
    sma20: 3.36,
    sma50: 3.28,
    sma200: 3.05,
    fastCross: "bull",
    fastCrossAgeBars: 3,
    regimeCross: null,
    regimeCrossAgeBars: 40,
    regime: "golden",
    fastSeparationPct: 0.0244,
    regimeSeparationPct: 0.0754,
    bars: 320,
    droppedBars: 0,
    quality: "full",
    regimeUnknown: false,
    warnings: [],
  },
};

const SAMPLES: CalibrationSample[] = Array.from({ length: 24 }, (_, i) => ({
  conviction: 0.6 + (i % 4) * 0.05,
  hit: i % 3 !== 0,
  forwardReturn: i % 3 !== 0 ? 0.012 : -0.009,
}));

const CALIBRATION = {
  report: buildCalibration(SAMPLES, { horizonDays: 5 }),
  samples: SAMPLES,
};

function renderPanel(props?: { unitsUnresolved?: boolean }) {
  // A fresh QueryClient per render proves cache identity does not leak into
  // the markup.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TradeExplanationPanel entry={ENTRY} calibration={CALIBRATION} {...props} />
    </QueryClientProvider>,
  );
}

describe("trade explanation panel determinism", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.42);
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders byte-identical markup across repeated renders", () => {
    const a = renderPanel();
    const b = renderPanel();
    const c = renderPanel();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("does not vary with wall-clock time", () => {
    const a = renderPanel();
    vi.setSystemTime(new Date("2027-11-11T23:59:59.000Z"));
    const b = renderPanel();
    vi.setSystemTime(FROZEN_NOW);
    expect(b).toBe(a);
  });

  it("does not vary with Math.random", () => {
    const a = renderPanel();
    (Math.random as unknown as { mockReturnValue: (v: number) => void }).mockReturnValue(0.99);
    const b = renderPanel();
    (Math.random as unknown as { mockReturnValue: (v: number) => void }).mockReturnValue(0.42);
    expect(b).toBe(a);
  });

  it("is stable under a reordered signal-weight object", () => {
    const reordered: AuditEntry = {
      ...ENTRY,
      signalWeights: {
        liquidity: 0.05,
        news_sentiment: 0.3,
        momentum_20d: 0.25,
        trend_score: 0.6,
      },
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TradeExplanationPanel entry={reordered} calibration={CALIBRATION} />
      </QueryClientProvider>,
    );
    expect(markup).toBe(renderPanel());
  });

  it("contains no time-sensitive or random-looking tokens", () => {
    const html = renderPanel();
    expect(html).not.toMatch(/\b(?:ago|just now|2026-03-02|09:3\d)\b/);
    expect(html).not.toMatch(/\b\d{13}\b/); // epoch millis
    expect(html).not.toMatch(/0\.\d{6,}/); // unrounded float leakage
  });

  it("locks the rendered explanation snapshot", () => {
    expect(renderPanel()).toMatchSnapshot();
  });

  it("locks the units-unresolved variant snapshot and its determinism", () => {
    const a = renderPanel({ unitsUnresolved: true });
    const b = renderPanel({ unitsUnresolved: true });
    expect(b).toBe(a);
    expect(a).toContain("Value withheld");
    expect(a).toMatchSnapshot();
  });

  it("keeps calibration wording identical when the same report is rebuilt", () => {
    const rebuilt = {
      report: buildCalibration([...SAMPLES], { horizonDays: 5 }),
      samples: [...SAMPLES],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TradeExplanationPanel entry={ENTRY} calibration={rebuilt} />
      </QueryClientProvider>,
    );
    expect(markup).toBe(renderPanel());
  });
});
