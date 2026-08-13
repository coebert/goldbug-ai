// Turns the 20-year news → market study into a playbook the trading engine
// consumes, and applies it when an event of a given kind hits a symbol.
//
// Pure module. The derivation from evidence is deterministic and testable, and
// the AI's proposed adjustments are merged through the same clamps, so a
// hallucinated number can never widen risk beyond the engine's hard bounds.

import { EVENT_KIND_META, MAX_EVENT_TILT, type MarketEventKind } from "./market-events";
import type { KindResponse, MacroHistoryStudy } from "./macro-history";
import { MACRO_EPISODES } from "./macro-history";

/** What history says to do when this kind of event lands. */
export type MacroResponse =
  /** Trade with the headline — the first move tends to extend. */
  | "follow"
  /** Trade against it — the first move tends to be given back. */
  | "fade"
  /** Do nothing on the headline itself; wait for confirmation. */
  | "wait"
  /** Cut gross exposure; this kind precedes the deep, slow drawdowns. */
  | "de_risk";

export type MacroPlaybookEntry = {
  kind: MacroEpisodeKindLike;
  response: MacroResponse;
  /** Multiplier applied to this kind's contribution to the event tilt, 0..2. */
  tilt_multiplier: number;
  /** How long the reaction stays actionable, in hours. */
  half_life_hours: number;
  /** Session count the engine should wait before acting when response = "wait". */
  confirm_sessions: number;
  /** 0..1 — how much evidence stands behind the entry. */
  confidence: number;
  /** One-line justification shown in the UI and the prompt. */
  note: string;
};

type MacroEpisodeKindLike = MarketEventKind | "liquidity_stress" | "retail_mania";

export type MacroDrawdownRule = {
  /** Inclusive drawdown depth this rule starts at, %. */
  from_pct: number;
  /** Scale applied to normal buy size while the index sits this deep, 0..1.5. */
  size_scale: number;
  /** Require a confirmed uptrend before adding at this depth. */
  require_trend: boolean;
  note: string;
};

export type MacroEventReelSummary = {
  events_total: number;
  events_measured: number;
  from: string;
  to: string;
  categories: import("./global-event-study").EventCategoryStat[];
  severe: { events: number; mean_drawdown_pct: number; mean_fwd_250d: number };
};

export type MacroLessonSet = {
  generated_at: string;
  model: string | null;
  /** Years of index history the study covered. */
  years_covered: number;
  /** Number of measured drawdown episodes behind the rules. */
  episodes: number;
  narrative: string;
  lessons: string[];
  playbook: MacroPlaybookEntry[];
  drawdown_rules: MacroDrawdownRule[];
  /** Rules learned specifically from the curated global-events reel. */
  event_lessons?: string[];
  /** Measured summary of the reel, by category and severity. */
  event_reel?: MacroEventReelSummary | null;
};


export const MACRO_TILT_MULTIPLIER_MAX = 2;
export const MACRO_HALF_LIFE_MIN = 6;
export const MACRO_HALF_LIFE_MAX = 336; // two weeks — themes outlive catalysts

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

const RESPONSES: MacroResponse[] = ["follow", "fade", "wait", "de_risk"];

/**
 * Catalogued priors from the documented episodes: which event kinds preceded
 * slow credit-origin bears (de-risk), which produced round-trips (fade), and
 * which were genuine repricings that extended (follow).
 */
const PRIOR_RESPONSE: Partial<Record<MacroEpisodeKindLike, MacroResponse>> = {
  credit_downgrade: "de_risk",
  recession_signal: "de_risk",
  inflation_hot: "de_risk",
  liquidity_stress: "fade",
  geopolitical_shock: "fade",
  retail_mania: "fade",
  sanctions: "wait",
  tariffs: "wait",
  rate_hike: "wait",
  jobs_data: "wait",
  rate_cut: "follow",
  inflation_cool: "follow",
  energy_shock: "follow",
  supply_disruption: "follow",
  earnings_beat: "follow",
  earnings_miss: "follow",
  guidance_raise: "follow",
  guidance_cut: "de_risk",
  mna: "follow",
  regulatory_probe: "wait",
  analyst_upgrade: "wait",
  analyst_downgrade: "wait",
  litigation: "wait",
  layoffs: "wait",
  buyback: "follow",
  dividend_cut: "de_risk",
  product_launch: "wait",
  cyber_incident: "fade",
  executive_exit: "wait",
};

const DEFAULT_NOTE: Partial<Record<MacroResponse, string>> = {
  follow: "The first move historically extended; trade with it while the trend agrees.",
  fade: "The first move was historically given back; wait for the round-trip instead of chasing.",
  wait: "Direction was not reliable from the headline alone; require price confirmation.",
  de_risk: "This kind preceded the slow, deep drawdowns; protect capital before hunting upside.",
};

function priorHalfLife(kind: MacroEpisodeKindLike): number {
  const meta = (EVENT_KIND_META as Record<string, { halfLifeHours: number } | undefined>)[kind];
  return meta?.halfLifeHours ?? 72;
}

export function defaultPlaybookEntry(kind: MacroEpisodeKindLike): MacroPlaybookEntry {
  const response = PRIOR_RESPONSE[kind] ?? "wait";
  const episodes = MACRO_EPISODES.filter((e) => e.kind === kind);
  return {
    kind,
    response,
    tilt_multiplier: response === "wait" ? 0.5 : response === "fade" ? 0.6 : 1,
    half_life_hours: clamp(priorHalfLife(kind), MACRO_HALF_LIFE_MIN, MACRO_HALF_LIFE_MAX),
    confirm_sessions: response === "wait" ? 1 : 0,
    confidence: episodes.length > 0 ? 0.35 : 0.2,
    note: episodes[0]?.lesson ?? DEFAULT_NOTE[response] ?? "",
  };
}

/** All kinds the playbook covers: every classifier kind plus catalogue-only ones. */
export function playbookKinds(): MacroEpisodeKindLike[] {
  const fromMeta = Object.keys(EVENT_KIND_META) as MacroEpisodeKindLike[];
  const extra: MacroEpisodeKindLike[] = ["liquidity_stress", "retail_mania"];
  return [...fromMeta, ...extra.filter((k) => !fromMeta.includes(k))];
}

/**
 * Blend the catalogued prior with whatever the app's own news history measured.
 * Measurement only overrides the prior once the sample is meaningful, and it
 * moves the entry by shrinkage rather than replacing it outright.
 */
export function derivePlaybookEntry(
  kind: MacroEpisodeKindLike,
  measured: KindResponse | undefined,
): MacroPlaybookEntry {
  const base = defaultPlaybookEntry(kind);
  if (!measured || measured.samples < 3) return base;

  // Confidence grows with sample size but saturates well below certainty:
  // a few weeks of headlines cannot overturn twenty years of episodes.
  const w = clamp(measured.samples / (measured.samples + 12), 0, 0.6);
  const decisive = Math.abs(measured.mean_fwd_5d) >= 0.5;
  const extends_ = measured.persistence > 0;

  let response = base.response;
  if (decisive && w >= 0.25) {
    if (base.response !== "de_risk") response = extends_ ? "follow" : "fade";
  }

  const strength = clamp(Math.abs(measured.mean_fwd_5d) / 3, 0, 1);
  const tilt = clamp(base.tilt_multiplier * (1 - w) + (0.4 + strength * 1.2) * w, 0, MACRO_TILT_MULTIPLIER_MAX);
  const halfLife = extends_ ? base.half_life_hours * 1.25 : base.half_life_hours * 0.6;

  return {
    ...base,
    response,
    tilt_multiplier: Number(tilt.toFixed(3)),
    half_life_hours: Math.round(clamp(halfLife, MACRO_HALF_LIFE_MIN, MACRO_HALF_LIFE_MAX)),
    confirm_sessions: response === "wait" ? 1 : 0,
    confidence: Number(clamp(base.confidence + w * 0.6, 0, 0.95).toFixed(3)),
    note:
      `Measured on ${measured.samples} event day(s): index ${measured.mean_fwd_5d >= 0 ? "+" : ""}${measured.mean_fwd_5d}% over 5 sessions, ` +
      `${extends_ ? "extending" : "reversing"} by day 20. ${base.note}`,
  };
}

export function derivePlaybook(study: MacroHistoryStudy): MacroPlaybookEntry[] {
  const measured = new Map(study.kind_responses.map((r) => [r.kind, r]));
  return playbookKinds().map((kind) => derivePlaybookEntry(kind, measured.get(kind)));
}

/**
 * Position-sizing rules by index drawdown depth, derived from the measured
 * forward returns at each depth. Historically the 5-10% bucket paid the best
 * risk-adjusted return, while depths beyond 20% needed a confirmed turn.
 */
export function deriveDrawdownRules(study: MacroHistoryStudy): MacroDrawdownRule[] {
  const rules: MacroDrawdownRule[] = [];
  for (const b of study.index.buckets) {
    const f3 = b.fwd_3m;
    if (f3.samples < 20) {
      rules.push({
        from_pct: b.bucket_from,
        size_scale: b.bucket_from >= 20 ? 0.6 : 1,
        require_trend: b.bucket_from >= 20,
        note: "Too few observations at this depth; kept at the neutral default.",
      });
      continue;
    }
    // Scale with the measured edge, capped so no bucket can more than double up.
    const edge = f3.mean_pct;
    const reliability = f3.hit_rate;
    const raw = 0.6 + clamp(edge / 8, -0.4, 0.5) + clamp((reliability - 0.6) * 1.2, -0.3, 0.4);
    rules.push({
      from_pct: b.bucket_from,
      size_scale: Number(clamp(raw, 0.3, 1.5).toFixed(2)),
      require_trend: b.bucket_from >= 20 || reliability < 0.55,
      note: `${f3.samples} observations from ${b.bucket_from}-${b.bucket_to}% below the high: 3-month forward return averaged ${edge >= 0 ? "+" : ""}${edge}% with a ${Math.round(reliability * 100)}% hit rate (worst ${f3.worst_pct}%).`,
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// AI adjustment merging
// ---------------------------------------------------------------------------

export type MacroPlaybookAdjustment = {
  kind?: string;
  response?: string;
  tilt_multiplier?: number;
  half_life_hours?: number;
  confirm_sessions?: number;
  note?: string;
};

export function mergePlaybookAdjustments(
  derived: MacroPlaybookEntry[],
  adjustments: MacroPlaybookAdjustment[] | null | undefined,
): MacroPlaybookEntry[] {
  if (!adjustments || adjustments.length === 0) return derived;
  const byKind = new Map(derived.map((e) => [String(e.kind), { ...e }]));

  for (const adj of adjustments) {
    const key = typeof adj?.kind === "string" ? adj.kind.trim() : "";
    const entry = byKind.get(key);
    // Unknown kinds are dropped: the model may not invent new event types.
    if (!entry) continue;

    if (typeof adj.response === "string" && (RESPONSES as string[]).includes(adj.response)) {
      entry.response = adj.response as MacroResponse;
    }
    if (adj.tilt_multiplier != null) {
      entry.tilt_multiplier = Number(
        clamp(Number(adj.tilt_multiplier), 0, MACRO_TILT_MULTIPLIER_MAX).toFixed(3),
      );
    }
    if (adj.half_life_hours != null) {
      entry.half_life_hours = Math.round(
        clamp(Number(adj.half_life_hours), MACRO_HALF_LIFE_MIN, MACRO_HALF_LIFE_MAX),
      );
    }
    if (adj.confirm_sessions != null) {
      entry.confirm_sessions = Math.round(clamp(Number(adj.confirm_sessions), 0, 5));
    }
    if (typeof adj.note === "string" && adj.note.trim().length > 0) {
      entry.note = adj.note.trim().slice(0, 240);
    }
    // A "wait" always carries at least one confirmation session, and a
    // de-risk stance can never be used to argue for a bigger tilt.
    if (entry.response === "wait" && entry.confirm_sessions < 1) entry.confirm_sessions = 1;
    if (entry.response === "de_risk") entry.tilt_multiplier = Math.min(entry.tilt_multiplier, 1);
    byKind.set(key, entry);
  }
  return derived.map((e) => byKind.get(String(e.kind)) ?? e);
}

export function mergeDrawdownRuleAdjustments(
  derived: MacroDrawdownRule[],
  adjustments: Array<{ from_pct?: number; size_scale?: number; require_trend?: boolean; note?: string }> | null | undefined,
): MacroDrawdownRule[] {
  if (!adjustments || adjustments.length === 0) return derived;
  return derived.map((rule) => {
    const adj = adjustments.find((a) => Number(a?.from_pct) === rule.from_pct);
    if (!adj) return rule;
    return {
      ...rule,
      size_scale:
        adj.size_scale == null ? rule.size_scale : Number(clamp(Number(adj.size_scale), 0.2, 1.5).toFixed(2)),
      require_trend: typeof adj.require_trend === "boolean" ? adj.require_trend : rule.require_trend,
      note: typeof adj.note === "string" && adj.note.trim() ? adj.note.trim().slice(0, 240) : rule.note,
    };
  });
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Multiplier the playbook applies to an event tilt built from `kinds`.
 * Averaged across the contributing kinds so a headline matching one "follow"
 * and one "wait" pattern lands between the two.
 */
export function playbookTiltMultiplier(
  kinds: readonly string[],
  playbook: MacroPlaybookEntry[] | null | undefined,
): number {
  if (!playbook || playbook.length === 0 || kinds.length === 0) return 1;
  const byKind = new Map(playbook.map((e) => [String(e.kind), e]));
  const hits = kinds.map((k) => byKind.get(String(k))).filter((e): e is MacroPlaybookEntry => !!e);
  if (hits.length === 0) return 1;
  const sum = hits.reduce((s, e) => s + (e.response === "fade" ? -e.tilt_multiplier : e.tilt_multiplier), 0);
  return Number(clamp(sum / hits.length, -MACRO_TILT_MULTIPLIER_MAX, MACRO_TILT_MULTIPLIER_MAX).toFixed(3));
}

/** Event tilt after the learned playbook is applied, still inside the hard cap. */
export function playbookAdjustedTilt(
  rawTilt: number,
  kinds: readonly string[],
  playbook: MacroPlaybookEntry[] | null | undefined,
): number {
  const mult = playbookTiltMultiplier(kinds, playbook);
  return Number(clamp(rawTilt * mult, -MAX_EVENT_TILT, MAX_EVENT_TILT).toFixed(3));
}

/** True when the playbook says this event flow needs price confirmation first. */
export function requiresConfirmation(
  kinds: readonly string[],
  playbook: MacroPlaybookEntry[] | null | undefined,
): boolean {
  if (!playbook) return false;
  const byKind = new Map(playbook.map((e) => [String(e.kind), e]));
  return kinds.some((k) => {
    const e = byKind.get(String(k));
    return !!e && e.response === "wait" && e.confirm_sessions > 0;
  });
}

/** Kinds the playbook flags as capital-preservation triggers. */
export function deRiskKinds(playbook: MacroPlaybookEntry[] | null | undefined): string[] {
  return (playbook ?? []).filter((e) => e.response === "de_risk").map((e) => String(e.kind));
}

/** Buy-size scale for the current index drawdown depth. */
export function drawdownSizeScale(
  drawdownPct: number | null | undefined,
  rules: MacroDrawdownRule[] | null | undefined,
): { scale: number; require_trend: boolean; note: string } {
  const neutral = { scale: 1, require_trend: false, note: "" };
  if (!rules || rules.length === 0) return neutral;
  const dd = Math.abs(Number(drawdownPct ?? 0));
  if (!Number.isFinite(dd)) return neutral;
  const sorted = [...rules].sort((a, b) => a.from_pct - b.from_pct);
  let hit = sorted[0]!;
  for (const r of sorted) if (dd >= r.from_pct) hit = r;
  return { scale: hit.size_scale, require_trend: hit.require_trend, note: hit.note };
}

/** Prompt block describing the learned playbook to the decision model. */
export function formatMacroPlaybookBlock(
  lessons: MacroLessonSet | null | undefined,
  drawdownPct: number | null | undefined,
  activeKinds: readonly string[],
): string {
  if (!lessons) return "";
  const lines: string[] = [
    `LEARNED MACRO PLAYBOOK (from ${lessons.years_covered} years of index history and ${lessons.episodes} drawdown episodes):`,
  ];
  for (const l of lessons.lessons.slice(0, 10)) lines.push(`- ${l}`);

  const relevant = lessons.playbook.filter((e) => activeKinds.includes(String(e.kind)));
  if (relevant.length > 0) {
    lines.push("Rules that apply to today's event tape:");
    for (const e of relevant.slice(0, 8)) {
      lines.push(
        `  • ${e.kind}: ${e.response.toUpperCase()} (tilt ×${e.tilt_multiplier}, decay ${e.half_life_hours}h) — ${e.note.slice(0, 160)}`,
      );
    }
  }

  const reelLessons = lessons.event_lessons ?? [];
  if (reelLessons.length > 0) {
    lines.push(
      `Learned from the global event reel (${lessons.event_reel?.events_measured ?? 0}/${lessons.event_reel?.events_total ?? 0} events measured, ${lessons.event_reel?.from ?? ""} → ${lessons.event_reel?.to ?? ""}):`,
    );
    for (const l of reelLessons.slice(0, 8)) lines.push(`  - ${l}`);
  }
  const reelCats = lessons.event_reel?.categories ?? [];
  if (reelCats.length > 0) {
    lines.push(
      `Event-category stance from the reel: ${reelCats
        .map((c) => `${c.category}=${c.stance.replace(/_/g, " ")}`)
        .join(", ")}.`,
    );
  }



  const dd = drawdownSizeScale(drawdownPct, lessons.drawdown_rules);
  if (dd.note) {
    lines.push(
      `Drawdown context: index is ${Math.abs(Number(drawdownPct ?? 0)).toFixed(1)}% below its high → size buys at ×${dd.scale}${dd.require_trend ? ", and only with a confirmed uptrend" : ""}. ${dd.note}`,
    );
  }
  lines.push(
    "Apply these as priors on top of the technicals: a FADE kind means do not chase the first move, a WAIT kind means require confirmation, and a DE_RISK kind means prefer trimming to adding even when the setup looks attractive.",
  );
  return lines.join("\n");
}
