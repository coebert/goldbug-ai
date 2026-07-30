/**
 * "One clear next action" — the single most useful thing a user can do
 * right now, derived from the state of their portfolios.
 *
 * Deliberately returns ONE action, never a list: the whole point is to
 * give a newcomer somewhere to look when the rest of the dashboard is
 * unfamiliar. Ordering below is by urgency, most urgent first.
 */
export type NextActionTone = "attention" | "action" | "calm";

export type NextAction = {
  id: string;
  /** Plain-English headline. No jargon, no abbreviations. */
  title: string;
  /** One sentence of why it matters, in plain English. */
  body: string;
  /** Label for the button. Verb-first. */
  ctaLabel: string;
  /** Where the button goes. */
  ctaTo: string;
  /** Optional hash target on the destination route. */
  ctaHash?: string;
  tone: NextActionTone;
};

export type NextActionInput = {
  portfolios: Array<{
    id: string;
    name?: string | null;
    mode?: string | null;
    /** Cash the portfolio has left to spend, if known. */
    current_cash?: number | null;
    starting_cash?: number | null;
  }>;
  /** True when a real-money portfolio exists but the broker isn't linked. */
  brokerDisconnected?: boolean;
  /** True when the latest AI run flagged the portfolio as too small to trade. */
  underfundedPortfolioId?: string | null;
  /** Number of equity snapshots seen so far (0 = the AI has never run). */
  snapshotCount?: number;
  /** True when at least one exchange the AI trades is open now. */
  marketOpen?: boolean;
  /** Human label for the next scheduled run, e.g. "11:00 BST". */
  nextRunLabel?: string | null;
};

export function deriveNextAction(input: NextActionInput): NextAction {
  const {
    portfolios,
    brokerDisconnected = false,
    underfundedPortfolioId = null,
    snapshotCount = 0,
    marketOpen = false,
    nextRunLabel = null,
  } = input;

  // 1. Nothing exists yet — the only sensible action is to start.
  if (portfolios.length === 0) {
    return {
      id: "create-first",
      title: "Start with a practice portfolio",
      body: "Pretend money, real market prices. You'll see how the AI invests without risking anything.",
      ctaLabel: "Start the £1,000 demo",
      ctaTo: "/get-started",
      tone: "action",
    };
  }

  // 2. A real-money portfolio can't do anything without a linked broker.
  if (brokerDisconnected) {
    return {
      id: "connect-broker",
      title: "Reconnect your broker account",
      body: "Your real-money portfolio can't buy or sell until the link to your broker is live again.",
      ctaLabel: "Reconnect broker",
      ctaTo: "/saxo-reconnect",
      tone: "attention",
    };
  }

  // 3. Funded too thinly to buy anything — the AI will keep doing nothing.
  if (underfundedPortfolioId) {
    return {
      id: "add-funds",
      title: "This portfolio is too small to buy anything",
      body: "Every share the AI looked at costs more than the portfolio can spend. Add funds or lower the minimum trade size.",
      ctaLabel: "Open the portfolio",
      ctaTo: `/portfolio/${underfundedPortfolioId}`,
      tone: "attention",
    };
  }

  // 4. Portfolio exists but the AI has never produced a snapshot.
  if (snapshotCount === 0) {
    return {
      id: "first-run",
      title: "Waiting for the AI's first decision",
      body: nextRunLabel
        ? `The AI reviews the market every hour. Its next look is at ${nextRunLabel} — nothing for you to do until then.`
        : "The AI reviews the market every hour. Nothing for you to do until it runs.",
      ctaLabel: "See how it decides",
      ctaTo: "/learn",
      tone: "calm",
    };
  }

  // 5. Steady state — explicitly tell the user there's nothing to do.
  return {
    id: "all-clear",
    title: "Nothing needs your attention",
    body: marketOpen
      ? "Markets are open and the AI is trading to plan. Have a look at what it did today if you're curious."
      : nextRunLabel
        ? `Markets are closed, so the AI is holding. Its next review is at ${nextRunLabel}.`
        : "Markets are closed, so the AI is holding.",
    ctaLabel: "See what the AI did today",
    ctaTo: "/trades",
    tone: "calm",
  };
}
