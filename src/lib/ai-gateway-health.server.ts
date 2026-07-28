// Probes the Lovable AI Gateway with a tiny request, classifies failure,
// and returns a structured verdict so callers (cron hook, admin UI) can
// decide whether to push-alert the operator and with what remedy.

export type GatewayHealthKind =
  | "ok"
  | "credit_hard_block"
  | "unauthorized"
  | "rate_limited"
  | "upstream_5xx"
  | "network"
  | "unknown";

export interface GatewayHealthVerdict {
  kind: GatewayHealthKind;
  httpStatus: number | null;
  detail: string;
  remedy: string;
  actionable: boolean; // true → needs a push alert (operator action required)
  probedAt: string;
}

const REMEDY: Record<GatewayHealthKind, string> = {
  ok: "OK",
  credit_hard_block:
    "Workspace credits exhausted. Add credits in Lovable → Settings → Plans & credits, or raise the workspace member credit cap.",
  unauthorized:
    "LOVABLE_API_KEY rejected. Rotate the key in Lovable (chat: 'rotate the AI gateway key').",
  rate_limited:
    "Gateway is rate-limiting. Transient — will retry automatically. Investigate if it persists >30 min.",
  upstream_5xx:
    "Upstream model provider is failing (5xx). Transient — will retry. Investigate if it persists >30 min.",
  network:
    "Could not reach ai.gateway.lovable.dev. Check outbound connectivity from the Worker.",
  unknown:
    "Gateway probe failed with an unrecognized error. Inspect gateway logs.",
};

export async function probeAiGateway(): Promise<GatewayHealthVerdict> {
  const now = new Date().toISOString();
  const key = process.env.LOVABLE_API_KEY;
  if (!key) {
    return {
      kind: "unauthorized",
      httpStatus: null,
      detail: "LOVABLE_API_KEY not set",
      remedy: REMEDY.unauthorized,
      actionable: true,
      probedAt: now,
    };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
        "X-Lovable-AIG-SDK": "aegis-health-probe",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: ac.signal,
    });

    if (res.ok) {
      return { kind: "ok", httpStatus: res.status, detail: "OK", remedy: REMEDY.ok, actionable: false, probedAt: now };
    }

    const bodyText = await res.text().catch(() => "");
    const lower = bodyText.toLowerCase();
    let kind: GatewayHealthKind = "unknown";
    if (res.status === 402 || lower.includes("credit_hard_block") || lower.includes("payment required") || lower.includes("insufficient credit")) {
      kind = "credit_hard_block";
    } else if (res.status === 401 || res.status === 403) {
      // 403 with credit_hard_block already caught above; remaining 403/401 = auth
      kind = lower.includes("credit") ? "credit_hard_block" : "unauthorized";
    } else if (res.status === 429) {
      kind = "rate_limited";
    } else if (res.status >= 500) {
      kind = "upstream_5xx";
    }

    return {
      kind,
      httpStatus: res.status,
      detail: `${res.status}: ${bodyText.slice(0, 300)}`,
      remedy: REMEDY[kind],
      actionable: kind === "credit_hard_block" || kind === "unauthorized",
      probedAt: now,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "network",
      httpStatus: null,
      detail: msg.slice(0, 300),
      remedy: REMEDY.network,
      actionable: false, // network blips retry — only alert on sustained failures
      probedAt: now,
    };
  } finally {
    clearTimeout(timer);
  }
}
