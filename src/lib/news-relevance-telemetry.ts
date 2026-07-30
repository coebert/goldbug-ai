// Pure instrumentation helpers for the Gemini news-relevance scorer.
//
// The scorer always produces a deterministic heuristic score; the LLM pass is
// an enrichment that can fail (missing key, rate limit, timeout, unparseable
// reply). These helpers classify those failures, aggregate per-batch latency,
// and describe *why* the deterministic scorer ended up carrying a run.

export type RelevanceFailureReason =
  | "missing_api_key"
  | "rate_limited"
  | "timeout"
  | "quota_exhausted"
  | "unparseable_reply"
  | "empty_reply"
  | "upstream_error";

export type RelevanceBatchTelemetry = {
  /** 0-based batch index within the run. */
  index: number;
  /** Headlines sent in this batch. */
  items: number;
  /** Headlines the LLM returned a usable score for. */
  scored: number;
  /** Wall-clock duration of the LLM call, in ms. */
  latencyMs: number;
  /** Failure classification, or null when the batch succeeded. */
  failure: RelevanceFailureReason | null;
  /** Short human-readable detail (error message head), when failed. */
  detail?: string;
};

export type RelevanceRunTelemetry = {
  date: string;
  trigger: string;
  items: number;
  batches: number;
  batchFailures: number;
  /** Headlines that received an LLM score. */
  llmScored: number;
  /** Headlines that fell back to the deterministic heuristic only. */
  fallbackItems: number;
  /** 0-1 share of headlines carried by the deterministic scorer. */
  fallbackRate: number;
  latencyMsTotal: number;
  latencyMsP50: number;
  latencyMsMax: number;
  /** Counts per failure reason across batches. */
  failureReasons: Partial<Record<RelevanceFailureReason, number>>;
  /** Plain-language explanation of the fallback, or null when none occurred. */
  fallbackReason: string | null;
};

const REASON_LABEL: Record<RelevanceFailureReason, string> = {
  missing_api_key: "AI gateway key missing",
  rate_limited: "rate limited by the AI gateway",
  timeout: "the model timed out",
  quota_exhausted: "AI credits exhausted",
  unparseable_reply: "the model replied with unparseable JSON",
  empty_reply: "the model returned no scores",
  upstream_error: "an upstream model error",
};

export function describeFailureReason(reason: RelevanceFailureReason): string {
  return REASON_LABEL[reason];
}

/** Map an arbitrary thrown value onto a stable failure bucket. */
export function classifyLlmFailure(err: unknown): RelevanceFailureReason {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  const status = Number(
    (err as { status?: unknown; statusCode?: unknown })?.status ??
      (err as { statusCode?: unknown })?.statusCode ??
      NaN,
  );
  if (status === 429 || msg.includes("rate limit") || msg.includes("too many requests")) return "rate_limited";
  if (status === 402 || msg.includes("payment required") || msg.includes("credit") || msg.includes("quota")) {
    return "quota_exhausted";
  }
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted")) return "timeout";
  return "upstream_error";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

/** Aggregate per-batch records into a single run summary. */
export function summarizeRelevanceRun(input: {
  date: string;
  trigger: string;
  items: number;
  batches: RelevanceBatchTelemetry[];
}): RelevanceRunTelemetry {
  const { batches } = input;
  const llmScored = batches.reduce((a, b) => a + b.scored, 0);
  const items = Math.max(input.items, llmScored);
  const fallbackItems = Math.max(0, items - llmScored);
  const latencies = batches.map((b) => b.latencyMs).sort((a, b) => a - b);

  const failureReasons: Partial<Record<RelevanceFailureReason, number>> = {};
  for (const b of batches) {
    if (!b.failure) continue;
    failureReasons[b.failure] = (failureReasons[b.failure] ?? 0) + 1;
  }
  const batchFailures = batches.filter((b) => b.failure).length;

  let fallbackReason: string | null = null;
  if (fallbackItems > 0) {
    const top = (Object.entries(failureReasons) as Array<[RelevanceFailureReason, number]>).sort(
      (a, b) => b[1] - a[1],
    )[0];
    fallbackReason = top
      ? `${fallbackItems} of ${items} headlines used the deterministic scorer because ${describeFailureReason(top[0])} (${top[1]} of ${batches.length} batch${batches.length === 1 ? "" : "es"} failed).`
      : `${fallbackItems} of ${items} headlines used the deterministic scorer because the model skipped them in an otherwise successful reply.`;
  }

  return {
    date: input.date,
    trigger: input.trigger,
    items,
    batches: batches.length,
    batchFailures,
    llmScored,
    fallbackItems,
    fallbackRate: items > 0 ? fallbackItems / items : 0,
    latencyMsTotal: latencies.reduce((a, b) => a + b, 0),
    latencyMsP50: percentile(latencies, 0.5),
    latencyMsMax: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
    failureReasons,
    fallbackReason,
  };
}

/** One-line log/UI summary of a run. */
export function formatRunTelemetry(t: RelevanceRunTelemetry): string {
  const pct = Math.round(t.fallbackRate * 100);
  const head = `${t.items} headline${t.items === 1 ? "" : "s"} · ${t.batches} batch${t.batches === 1 ? "" : "es"} · p50 ${t.latencyMsP50}ms · max ${t.latencyMsMax}ms · fallback ${pct}%`;
  return t.fallbackReason ? `${head} — ${t.fallbackReason}` : `${head} — full Gemini coverage`;
}
