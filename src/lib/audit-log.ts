// Pure derivation of trade audit entries from persisted `decisions` rows.
//
// Each decision row already stores everything we need in its `raw` JSONB
// column: the AI's proposed orders, per-order signal weights and conviction,
// the guardrail configuration in force, the headline set fed to the model,
// and the executed/rejected outcomes. This module flattens that structure
// into one row per order so the UI can render a chronological, filterable,
// exportable audit trail — the "who / what / why / with which inputs" for
// every AI decision.

export type AuditRuleTag =
  | "executed"
  | "rejected"
  | "halt"
  | "cash_floor"
  | "position_cap"
  | "new_position_cap"
  | "affordability"
  | "min_trade_value"
  | "unknown_block";

export type AuditNewsFactor = {
  headline: string;
  source: string | null;
  sentiment: number | null;
  alignment: "aligned" | "opposing" | "neutral";
};

export type AuditEntry = {
  decisionId: string;
  runDate: string;
  orderIndex: number;
  symbol: string;
  side: "buy" | "sell";
  status: "executed" | "rejected";
  quantity: number;
  price: number;
  value: number;
  reason: string;
  rejectedReason: string | null;
  conviction: number | null;
  signalWeights: Record<string, number> | null;
  ruleTags: AuditRuleTag[];
  newsFactors: AuditNewsFactor[];
  guardrails: Record<string, unknown> | null;
  portfolioValue: number | null;
  /** SMA trend snapshot the crossover rules saw when this order was decided. */
  smaCross: import("./alpha/sma-cross-rules").SmaCrossState | null;
  /** Risk setting in force for the run — drives the SMA thresholds. */
  riskLevel: string | null;
};

type LooseDecision = {
  id: string;
  run_date: string;
  portfolio_value: number | string | null;
  raw: unknown;
};

type LooseOrder = {
  symbol?: string;
  side?: "buy" | "sell";
  quantity?: number;
  price?: number;
  value?: number;
  reason?: string;
  rejected?: string;
  conviction?: number | null;
  signal_weights?: Record<string, unknown>;
  sma_cross?: unknown;
};

type LooseNews = {
  headline?: string;
  source?: string | null;
  sentiment?: number | null;
};

function classifyRejection(reason: string | undefined): AuditRuleTag {
  if (!reason) return "unknown_block";
  const r = reason.toLowerCase();
  if (r.includes("halt")) return "halt";
  if (r.includes("cash floor") || r.includes("cash_floor")) return "cash_floor";
  if (r.includes("max position") || r.includes("position cap") || r.includes("position_cap"))
    return "position_cap";
  if (r.includes("new position") || r.includes("per day") || r.includes("per-day"))
    return "new_position_cap";
  if (r.includes("afford") || r.includes("budget")) return "affordability";
  if (r.includes("min trade") || r.includes("min_trade") || r.includes("minimum trade"))
    return "min_trade_value";
  return "unknown_block";
}

function classifyNews(headline: string, symbol: string, side: "buy" | "sell", sentiment: number | null): AuditNewsFactor["alignment"] {
  if (!headline.toLowerCase().includes(symbol.toLowerCase())) return "neutral";
  if (sentiment == null) return "neutral";
  if (Math.abs(sentiment) < 0.1) return "neutral";
  const positive = sentiment > 0;
  if (side === "buy") return positive ? "aligned" : "opposing";
  return positive ? "opposing" : "aligned";
}

/** Accept only a structurally valid SMA snapshot; anything else is dropped. */
function readSmaCross(v: unknown): AuditEntry["smaCross"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.price !== "number" || !Number.isFinite(o.price)) return null;
  return v as AuditEntry["smaCross"];
}

export function buildAuditEntries(decisions: LooseDecision[]): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const d of decisions) {
    const raw = (d.raw ?? {}) as {
      orders?: LooseOrder[];
      executed?: LooseOrder[];
      news?: LooseNews[];
      guardrails?: Record<string, unknown>;
    };
    const executed = raw.executed ?? [];
    const orders = raw.orders ?? [];
    const news = raw.news ?? [];
    const guardrails = raw.guardrails ?? null;

    // Match AI-proposed metadata (weights, conviction) back onto executed rows
    // by symbol+side so the audit trail shows exactly what the model saw.
    const metaByKey = new Map<string, LooseOrder>();
    for (const o of orders) {
      if (!o?.symbol || !o?.side) continue;
      metaByKey.set(`${o.symbol.toUpperCase()}:${o.side}`, o);
    }

    executed.forEach((o, i) => {
      const symbol = String(o.symbol ?? "").toUpperCase();
      const side = (o.side ?? "buy") as "buy" | "sell";
      const rejected = o.rejected;
      const status: AuditEntry["status"] = rejected ? "rejected" : "executed";
      const tags: AuditRuleTag[] = [];
      if (status === "executed") tags.push("executed");
      else tags.push("rejected", classifyRejection(rejected));

      const meta = metaByKey.get(`${symbol}:${side}`);
      const weights = meta?.signal_weights
        ? Object.fromEntries(
            Object.entries(meta.signal_weights).filter(([, v]) => typeof v === "number") as [string, number][],
          )
        : null;

      const newsFactors: AuditNewsFactor[] = [];
      for (const n of news) {
        if (!n?.headline) continue;
        const alignment = classifyNews(n.headline, symbol, side, n.sentiment ?? null);
        if (alignment === "neutral") continue;
        newsFactors.push({
          headline: n.headline,
          source: n.source ?? null,
          sentiment: n.sentiment ?? null,
          alignment,
        });
      }

      out.push({
        decisionId: d.id,
        runDate: d.run_date,
        orderIndex: i,
        symbol,
        side,
        status,
        quantity: Number(o.quantity ?? 0),
        price: Number(o.price ?? 0),
        value: Number(o.value ?? 0),
        reason: String(o.reason ?? ""),
        rejectedReason: rejected ? String(rejected) : null,
        conviction: typeof meta?.conviction === "number" ? meta.conviction : null,
        signalWeights: weights && Object.keys(weights).length ? weights : null,
        ruleTags: tags,
        newsFactors,
        guardrails,
        portfolioValue: d.portfolio_value != null ? Number(d.portfolio_value) : null,
        smaCross: readSmaCross(o.sma_cross ?? meta?.sma_cross),
        riskLevel:
          typeof guardrails?.risk_level === "string" ? (guardrails.risk_level as string) : null,
      });
    });
  }

  // Newest first, then symbol for stable ordering within a run.
  out.sort((a, b) => {
    if (a.runDate !== b.runDate) return a.runDate < b.runDate ? 1 : -1;
    if (a.decisionId !== b.decisionId) return a.decisionId < b.decisionId ? 1 : -1;
    return a.orderIndex - b.orderIndex;
  });
  return out;
}

export const RULE_TAG_LABELS: Record<AuditRuleTag, string> = {
  executed: "Executed",
  rejected: "Rejected",
  halt: "Risk halt",
  cash_floor: "Cash floor",
  position_cap: "Position cap",
  new_position_cap: "New-position cap",
  affordability: "Affordability",
  min_trade_value: "Min trade value",
  unknown_block: "Other guardrail",
};

export function entriesToCsv(entries: AuditEntry[]): string {
  const headers = [
    "run_date",
    "decision_id",
    "order_index",
    "symbol",
    "side",
    "status",
    "quantity",
    "price",
    "value",
    "conviction",
    "rule_tags",
    "news_aligned",
    "news_opposing",
    "reason",
    "rejected_reason",
  ];
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e) =>
    [
      e.runDate,
      e.decisionId,
      e.orderIndex,
      e.symbol,
      e.side,
      e.status,
      e.quantity,
      e.price,
      e.value,
      e.conviction ?? "",
      e.ruleTags.join("|"),
      e.newsFactors.filter((n) => n.alignment === "aligned").length,
      e.newsFactors.filter((n) => n.alignment === "opposing").length,
      e.reason,
      e.rejectedReason ?? "",
    ]
      .map(escape)
      .join(","),
  );
  return [headers.join(","), ...rows].join("\n");
}

export function downloadBlob(content: string, filename: string, mime: string) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
