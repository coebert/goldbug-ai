// Mirror detection: two portfolios that are supposed to run independent
// strategies but end up showing byte-identical holdings and equity.
//
// The classic cause is account-linking: both portfolios resolve to the same
// broker account (either explicitly via the same `broker_account_id`, or
// implicitly because neither is linked and a sync path fell back to a global
// default account key). When that happens every sync writes the same broker
// snapshot into both books, so the UI shows two "different" risk levels with
// identical numbers.
//
// This module is pure so it can be unit-tested and reused by the server check
// and by UI diagnostics.

export interface MirrorHolding {
  symbol: string;
  quantity: number;
  avg_cost?: number | null;
}

export interface MirrorPortfolioInput {
  id: string;
  name: string;
  mode?: string | null;
  risk_level?: string | null;
  broker?: string | null;
  broker_account_id?: string | null;
  /** Cash in portfolio currency. */
  current_cash: number;
  /** Total equity (cash + holdings value) in portfolio currency. */
  equity: number;
  currency?: string | null;
  holdings: MirrorHolding[];
}

export type MirrorCause =
  | "shared_broker_account"
  | "unlinked_default_account_fallback"
  | "linked_and_unlinked_mismatch"
  | "unknown";

export type MirrorSeverity = "error" | "warning";

export interface MirrorFinding {
  code: "portfolio_mirror";
  severity: MirrorSeverity;
  cause: MirrorCause;
  portfolioIds: [string, string];
  portfolioNames: [string, string];
  brokerAccountIds: [string | null, string | null];
  /** Shared holdings fingerprint that matched. */
  holdingsFingerprint: string;
  symbols: string[];
  equity: [number, number];
  cash: [number, number];
  equityDeltaPct: number;
  cashDeltaPct: number;
  message: string;
  details: string[];
}

export interface MirrorDetectOptions {
  /** Max relative difference (0-1) still counted as "identical". Default 0.0005 (0.05%). */
  tolerancePct?: number;
  /** Ignore pairs whose books are both empty and cash both zero. Default true. */
  ignoreEmpty?: boolean;
}

const DEFAULT_TOLERANCE = 0.0005;

function normalizeId(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length ? s : null;
}

function round(n: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round((Number.isFinite(n) ? n : 0) * f) / f;
}

/** Stable, order-independent fingerprint of a holdings book. */
export function holdingsFingerprint(holdings: MirrorHolding[]): string {
  const merged = new Map<string, number>();
  for (const h of holdings ?? []) {
    const sym = (h?.symbol ?? "").trim().toUpperCase();
    if (!sym) continue;
    const qty = Number(h?.quantity) || 0;
    if (qty === 0) continue;
    merged.set(sym, round((merged.get(sym) ?? 0) + qty));
  }
  return [...merged.entries()]
    .filter(([, q]) => q !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([s, q]) => `${s}:${q}`)
    .join("|");
}

/** Relative difference between two numbers; 0 when both are ~0. */
export function relDiff(a: number, b: number): number {
  const x = Number.isFinite(a) ? a : 0;
  const y = Number.isFinite(b) ? b : 0;
  const scale = Math.max(Math.abs(x), Math.abs(y));
  if (scale < 1e-9) return 0;
  return Math.abs(x - y) / scale;
}

function classify(a: MirrorPortfolioInput, b: MirrorPortfolioInput): MirrorCause {
  const ka = normalizeId(a.broker_account_id);
  const kb = normalizeId(b.broker_account_id);
  if (ka && kb) return ka === kb ? "shared_broker_account" : "unknown";
  if (!ka && !kb) return "unlinked_default_account_fallback";
  return "linked_and_unlinked_mismatch";
}

const CAUSE_TEXT: Record<MirrorCause, string> = {
  shared_broker_account:
    "Both portfolios are linked to the same broker account, so every sync writes the same broker snapshot into both books.",
  unlinked_default_account_fallback:
    "Neither portfolio has a broker account link, so a sync path may have fallen back to a global default account and mirrored it into both books.",
  linked_and_unlinked_mismatch:
    "One portfolio is linked to a broker account and the other is not, yet their books match — the unlinked portfolio is most likely inheriting the linked account's data.",
  unknown:
    "The portfolios are linked to different broker accounts, so identical books point at a sync or seeding bug rather than account-linking.",
};

/**
 * Detect pairs of portfolios whose holdings AND equity are identical (within
 * tolerance). Returns one finding per offending pair, most severe first.
 */
export function detectMirroredPortfolios(
  portfolios: MirrorPortfolioInput[],
  options: MirrorDetectOptions = {},
): MirrorFinding[] {
  const tol = options.tolerancePct ?? DEFAULT_TOLERANCE;
  const ignoreEmpty = options.ignoreEmpty ?? true;
  const list = (portfolios ?? []).filter(Boolean);
  const findings: MirrorFinding[] = [];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.id === b.id) continue;

      const fa = holdingsFingerprint(a.holdings ?? []);
      const fb = holdingsFingerprint(b.holdings ?? []);
      if (fa !== fb) continue;

      const equityDelta = relDiff(a.equity, b.equity);
      const cashDelta = relDiff(a.current_cash, b.current_cash);
      if (equityDelta > tol || cashDelta > tol) continue;

      const empty = fa === "" && Math.abs(a.equity) < 1e-9 && Math.abs(b.equity) < 1e-9;
      if (ignoreEmpty && empty) continue;

      const cause = classify(a, b);
      const symbols = fa ? fa.split("|").map((p) => p.split(":")[0]) : [];
      const severity: MirrorSeverity = cause === "unknown" ? "warning" : "error";

      const details = [
        CAUSE_TEXT[cause],
        `Holdings fingerprint: ${fa || "(empty book)"}`,
        `Equity: ${a.equity} vs ${b.equity} (${(equityDelta * 100).toFixed(4)}% apart)`,
        `Cash: ${a.current_cash} vs ${b.current_cash} (${(cashDelta * 100).toFixed(4)}% apart)`,
        `Broker account: ${normalizeId(a.broker_account_id) ?? "none"} vs ${normalizeId(b.broker_account_id) ?? "none"}`,
      ];
      if (a.risk_level && b.risk_level && a.risk_level !== b.risk_level) {
        details.push(
          `Risk levels differ (${a.risk_level} vs ${b.risk_level}) — identical books are impossible under independent strategies.`,
        );
      }

      findings.push({
        code: "portfolio_mirror",
        severity,
        cause,
        portfolioIds: [a.id, b.id],
        portfolioNames: [a.name, b.name],
        brokerAccountIds: [normalizeId(a.broker_account_id), normalizeId(b.broker_account_id)],
        holdingsFingerprint: fa,
        symbols,
        equity: [a.equity, b.equity],
        cash: [a.current_cash, b.current_cash],
        equityDeltaPct: round(equityDelta * 100, 6),
        cashDeltaPct: round(cashDelta * 100, 6),
        message: `"${a.name}" and "${b.name}" show identical holdings and equity (${symbols.length} position${symbols.length === 1 ? "" : "s"}, equity ${a.equity}).`,
        details,
      });
    }
  }

  return findings.sort((x, y) =>
    x.severity === y.severity ? 0 : x.severity === "error" ? -1 : 1,
  );
}

/** Convenience: true when any error-severity mirror was detected. */
export function hasMirrorError(findings: MirrorFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}
