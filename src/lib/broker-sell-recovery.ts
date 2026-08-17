/**
 * Price-format failures must not strand an exit. These are safe to retry as a
 * market sell because Saxo already accepted the symbol, quantity and account;
 * only the protective limit representation was invalid.
 */
export function shouldRetrySellAsMarket(args: {
  side: "buy" | "sell";
  status: string;
  reason?: string | null;
}): boolean {
  if (args.side !== "sell") return false;
  if (args.status !== "rejected" && args.status !== "error") return false;
  const reason = String(args.reason ?? "").toLowerCase();
  return (
    reason.includes("tick size") ||
    reason.includes("tick-size") ||
    reason.includes("price exceeds aggressive tolerance") ||
    reason.includes("price tolerance")
  );
}