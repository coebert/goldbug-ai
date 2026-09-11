// "Close now" for a single open FX funding leg.
//
// The money-moving work lives in `fx-leg-close.server.ts` so the automatic
// loser sweep books a close exactly the same way. This file is only the
// TOTP-gated door onto it.

import { createServerFn } from "@tanstack/react-start";
import { requireAal2 } from "./_server/require-aal2";
import { z } from "zod";
import type { CloseFxLegResult } from "./fx-leg-close-types";

export type { CloseFxLegResult };

export const closeFxLeg = createServerFn({ method: "POST" })
  // Money-moving action — same TOTP step-up as manual sells and conversions.
  .middleware([requireAal2])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        symbol: z.string().min(3).max(32),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<CloseFxLegResult> => {
    const { closeFxLegCore } = await import("./fx-leg-close.server");
    return closeFxLegCore({
      supabase: context.supabase,
      userId: context.userId,
      portfolioId: data.portfolioId,
      symbol: data.symbol,
    });
  });
