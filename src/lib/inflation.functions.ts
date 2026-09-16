// Read-only inflation snapshot for the UI. No LLM credits are spent here.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getInflation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getInflationSnapshot } = await import("./inflation.server");
    const { readInflation } = await import("./inflation");
    const snap = await getInflationSnapshot();
    if (!snap) return { fetchedAt: null, points: [] as unknown[] };
    return {
      fetchedAt: snap.fetchedAt,
      points: snap.points.map((p) => ({ ...p, read: readInflation(p) })),
    };
  });
