// FX audit surface for the Saxo SIM run details view.
//
// Returns the *exact* rate that the sizer would apply right now for each
// USD/GBP/EUR cross-pair, plus the resolved provider (source) and the
// observation timestamp of the underlying rate. This makes it possible to
// prove — post-hoc — which quote drove a given tick's cross-currency
// sizing decisions instead of guessing from the individual FX_CAPTURE log
// entries (which only cover one pair per portfolio per tick).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  AUDIT_CCYS,
  type AuditCcy,
  type FxAuditPair,
} from "@/lib/fx-audit.server";

type Ccy = AuditCcy;
export type { FxAuditPair };

export type FxAuditSnapshot = {
  requestedAt: string;
  base: Ccy | null;
  pairs: FxAuditPair[];
  /**
   * Latest FX_CAPTURE row (portfolio-specific — the one the executor
   * actually recorded for this SIM tick), so the audit UI can show both
   * "what sizing would use now" and "what was captured on the last run".
   */
  lastCapture: {
    createdAt: string;
    pair: string;
    rate: number | null;
    source: string | null;
    stale: boolean | null;
    env: string | null;
  } | null;
};

export const getFxAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<FxAuditSnapshot> => {
    // Load portfolio base currency so the UI can emphasise the row that
    // actually funds sizing on this account.
    const pf = await context.supabase
      .from("portfolios")
      .select("currency")
      .eq("id", data.portfolioId)
      .maybeSingle();
    const rawBase = (pf.data?.currency as string | undefined)?.toUpperCase();
    const base: Ccy | null =
      rawBase && (AUDIT_CCYS as readonly string[]).includes(rawBase)
        ? (rawBase as Ccy)
        : null;

    const { buildFxAuditPairs } = await import("@/lib/fx-audit.server");
    const pairs = await buildFxAuditPairs();

    // Also fetch the most recent FX_CAPTURE for this portfolio so the card
    // can cross-check the live rate against what was captured mid-tick.
    const cap = await context.supabase
      .from("live_broker_log")
      .select("created_at, path, response, env")
      .eq("portfolio_id", data.portfolioId)
      .eq("method", "FX_CAPTURE")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let lastCapture: FxAuditSnapshot["lastCapture"] = null;
    if (cap.data) {
      const path = (cap.data.path as string | null) ?? "";
      const m = /\/fx\/([A-Z]{3}->[A-Z]{3})/.exec(path);
      const resp = (cap.data.response ?? {}) as {
        rate?: number;
        source?: string;
        stale?: boolean;
      };
      lastCapture = {
        createdAt: cap.data.created_at as string,
        pair: m?.[1] ?? "unknown",
        rate: typeof resp.rate === "number" ? resp.rate : null,
        source: resp.source ?? null,
        stale: resp.stale ?? null,
        env: (cap.data.env as string | null) ?? null,
      };
    }

    return {
      requestedAt: new Date().toISOString(),
      base,
      pairs: pairs.sort((a, b) =>
        (a.from + a.to).localeCompare(b.from + b.to),
      ),
      lastCapture,
    };
  });
