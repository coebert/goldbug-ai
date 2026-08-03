// Zod schemas for the Saxo OpenAPI payloads this app consumes.
//
// Phase 5 (type-safety hygiene): `SaxoAdapter.req<T>()` used to cast the parsed
// JSON body straight to a caller-supplied interface, so a provider-side shape
// change surfaced far away as `undefined` maths (NaN prices, zero quantities)
// instead of at the boundary.
//
// Every schema here is deliberately LENIENT:
//   * unknown keys pass through (`.passthrough()`) — Saxo adds fields often;
//   * every field is optional, matching the previous hand-written interfaces;
//   * numeric fields are coerced, because Saxo occasionally quotes numbers.
//
// `parseSaxo` never throws: a mismatch is logged once with the endpoint and the
// issue list, and the raw body is returned unchanged. Validation is there to
// make drift visible, not to break live trading.

import { z } from "zod";
import { createLogger } from "@/lib/_server/log";

const log = createLogger("saxo:schema");

const num = z.coerce.number().optional();
const str = z.string().optional();

export const SaxoErrorInfoSchema = z
  .object({ Message: str, ErrorCode: str })
  .passthrough();

export const SaxoUserSchema = z
  .object({ ClientKey: str, UserKey: str, Name: str })
  .passthrough();

export const SaxoBalanceSchema = z
  .object({
    CashBalance: num,
    TransactionsNotBooked: num,
    SpendingPower: num,
    TotalValue: num,
    Currency: str,
  })
  .passthrough();

export const SaxoNetPositionSchema = z
  .object({
    NetPositionBase: z
      .object({
        Amount: num,
        AmountLong: num,
        AmountShort: num,
        AverageOpenPrice: num,
        Uic: num,
        AssetType: str,
      })
      .passthrough()
      .optional(),
    NetPositionView: z
      .object({
        CurrentPrice: num,
        Exposure: num,
        ExposureInBaseCurrency: num,
        MarketValue: num,
        MarketValueInBaseCurrency: num,
        MarketValueOpen: num,
        MarketValueOpenInBaseCurrency: num,
        AverageOpenPrice: num,
        AverageOpenPriceIncludingCosts: num,
        PositionsAverageBuyPrice: num,
        ProfitLossOnTrade: num,
        ProfitLossOnTradeInBaseCurrency: num,
      })
      .passthrough()
      .optional(),
    DisplayAndFormat: z
      .object({ Symbol: str, Currency: str, Description: str })
      .passthrough()
      .optional(),
    AssetType: str,
    Uic: num,
  })
  .passthrough();

export const SaxoNetPositionsSchema = z
  .object({ Data: z.array(SaxoNetPositionSchema).optional() })
  .passthrough();

export const SaxoInstrumentDetailsSchema = z
  .object({ Symbol: str, CurrencyCode: str, AssetType: str })
  .passthrough();

export const SaxoPlaceOrderSchema = z
  .object({ OrderId: str, Price: num, ErrorInfo: SaxoErrorInfoSchema.optional() })
  .passthrough();

export const SaxoWorkingOrdersSchema = z
  .object({
    Data: z
      .array(
        z
          .object({
            OrderId: str,
            Status: str,
            Amount: num,
            FilledAmount: num,
            BuySell: str,
            Price: num,
            OrderPrice: num,
            AssetType: str,
            DisplayAndFormat: z.object({ Symbol: str, Currency: str }).passthrough().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const SaxoAccountsSchema = z
  .object({
    Data: z
      .array(
        z
          .object({
            AccountKey: str,
            Active: z.boolean().optional(),
            Currency: str,
            LegalAssetTypes: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type SaxoSchemaName =
  | "user"
  | "balance"
  | "netpositions"
  | "instrumentDetails"
  | "placeOrder"
  | "workingOrders"
  | "accounts";

/**
 * Validate a Saxo response body without ever failing the request.
 *
 * Returns the parsed value on success; on mismatch it logs the endpoint plus
 * the first few Zod issues and returns the raw body, preserving the previous
 * cast-and-hope behaviour for any field the schema did not anticipate.
 */
export function parseSaxo<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  ctx: { method: string; path: string },
): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data as z.infer<S>;
  log.warn("saxo response did not match schema", {
    method: ctx.method,
    path: ctx.path,
    issues: result.error.issues.slice(0, 5).map((i) => ({
      path: i.path.join("."),
      code: i.code,
      message: i.message,
    })),
  });
  return value as z.infer<S>;
}
