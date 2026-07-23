// Client-safe Zod schemas for pending_slices inputs.
//
// These schemas mirror the server-side validation in
// `execution-slicer.server.ts` so the UI can validate user-provided values
// (portfolio id, symbol, side, quantities, slice counts, TTLs, fill amounts)
// before making a server call. Rejecting garbage inputs at the form layer
// removes a whole class of `portfolio_not_found` / `slice_lookup_failed`
// noise from the SECURITY:pending_slices logs.
//
// IMPORTANT: this file must remain free of server-only imports so it can be
// bundled into the client. The server module re-exports these schemas and
// enforces them again — never trust the client validation alone.

import { z } from "zod";

export const UUID = z.string().trim().uuid();

export const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  // Common Yahoo/Saxo symbol shapes: AAPL, BRK.B, RDS-A, ES=F, BTC-USD.
  .regex(/^[A-Za-z0-9._:=/-]+$/, "invalid symbol");

export const SIDE = z.enum(["buy", "sell"]);
export const POSITIVE = z.number().finite().positive();
export const NON_NEG = z.number().finite().nonnegative();

export const SLICE_COUNT = z.number().int().min(2).max(8);
export const TTL_MINUTES = z.number().int().min(1).max(24 * 60);

export const IDEMPOTENCY_KEY = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "invalid idempotency key");

export const SliceInputSchema = z.object({
  portfolioId: UUID,
  ownerUserId: UUID,
  decisionId: UUID.nullable(),
  symbol: SYMBOL,
  side: SIDE,
  totalQty: POSITIVE.max(1e9),
  priceHint: POSITIVE.max(1e9),
  slices: SLICE_COUNT.optional(),
  ttlMinutes: TTL_MINUTES.optional(),
  idempotencyKey: IDEMPOTENCY_KEY.optional(),
});

export const FillInputSchema = z.object({
  sliceId: UUID,
  ownerUserId: UUID,
  filledQty: NON_NEG.max(1e9),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: IDEMPOTENCY_KEY.optional(),
});


export const TickInputSchema = z.object({
  portfolioId: UUID,
  ownerUserId: UUID,
});

export type SliceInput = z.input<typeof SliceInputSchema>;
export type FillInput = z.input<typeof FillInputSchema>;
export type TickInput = z.input<typeof TickInputSchema>;
