// Admin-facing reader for the security_audit_log table.
//
// Single-user app: every signed-in caller is the admin. RLS on the audit
// table restricts rows to `actor_user_id = auth.uid()`, so we query via
// `requireSupabaseAuth` (not supabaseAdmin) and let the policy scope
// results automatically.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const FilterSchema = z.object({
  event: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(64).optional(),
  op: z.string().trim().min(1).max(64).optional(),
  portfolioId: z.string().trim().uuid().optional(),
  sinceHours: z.number().int().min(1).max(24 * 30).default(24),
  limit: z.number().int().min(1).max(500).default(100),
});

export type SecurityAuditFilter = z.input<typeof FilterSchema>;

export type SecurityAuditRow = {
  id: string;
  event: string;
  op: string | null;
  reason: string | null;
  portfolio_id: string | null;
  slice_id: string | null;
  actor_user_id: string | null;
  details: unknown;
  created_at: string;
};

export type SecurityAuditResult = {
  rows: SecurityAuditRow[];
  totalReturned: number;
  filters: {
    event?: string;
    reason?: string;
    op?: string;
    portfolioId?: string;
    sinceHours: number;
    limit: number;
  };
  distinct: {
    events: string[];
    reasons: string[];
    ops: string[];
  };
};

export const listSecurityAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => FilterSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<SecurityAuditResult> => {
    const { supabase } = context;
    const since = new Date(Date.now() - data.sinceHours * 60 * 60 * 1000).toISOString();

    let q = supabase
      .from("security_audit_log")
      .select("id, event, op, reason, portfolio_id, slice_id, actor_user_id, details, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (data.event) q = q.eq("event", data.event);
    if (data.reason) q = q.eq("reason", data.reason);
    if (data.op) q = q.eq("op", data.op);
    if (data.portfolioId) q = q.eq("portfolio_id", data.portfolioId);

    const { data: rows, error } = await q;
    if (error) throw new Error(`security_audit_log query failed: ${error.message}`);

    const list = (rows ?? []) as SecurityAuditRow[];
    const uniq = (vals: Array<string | null>) =>
      Array.from(new Set(vals.filter((v): v is string => !!v))).sort();

    return {
      rows: list,
      totalReturned: list.length,
      filters: {
        event: data.event,
        reason: data.reason,
        op: data.op,
        portfolioId: data.portfolioId,
        sinceHours: data.sinceHours,
        limit: data.limit,
      },
      distinct: {
        events: uniq(list.map((r) => r.event)),
        reasons: uniq(list.map((r) => r.reason)),
        ops: uniq(list.map((r) => r.op)),
      },
    };
  });
