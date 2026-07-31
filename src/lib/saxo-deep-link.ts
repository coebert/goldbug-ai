// Deep links into the SaxoTraderGO Corporate Actions screen.
//
// Saxo does not document a per-event permalink, so this builds the closest
// stable thing: the Corporate Actions workspace on the right environment
// (live vs sim), with the account, instrument and event id attached as query
// hints. If Saxo ignores a hint the user still lands on the correct screen
// for the correct account rather than the platform home page — the link
// degrades, it never breaks.

export type SaxoEnv = "live" | "sim" | null | undefined;

const BASE_LIVE = "https://www.saxotrader.com/d/corporateactions";
const BASE_SIM = "https://www.saxotrader.com/sim/d/corporateactions";

export type SaxoDeepLinkInput = {
  env: SaxoEnv;
  accountKey?: string | null;
  eventId?: string | null;
  uic?: number | null;
  symbol?: string | null;
};

/** Base Corporate Actions workspace URL for the environment. */
export function saxoCorporateActionsBase(env: SaxoEnv): string {
  return env === "live" ? BASE_LIVE : BASE_SIM;
}

/**
 * One-click link to the Corporate Actions screen, scoped as tightly as the
 * available identifiers allow. Blank/whitespace values are dropped so the URL
 * never carries empty params.
 */
export function buildSaxoCorporateActionLink({
  env,
  accountKey,
  eventId,
  uic,
  symbol,
}: SaxoDeepLinkInput): string {
  const url = new URL(saxoCorporateActionsBase(env));
  const put = (key: string, value: string | null | undefined) => {
    const v = value?.trim();
    if (v) url.searchParams.set(key, v);
  };
  put("AccountKey", accountKey);
  put("EventId", eventId);
  if (uic != null && Number.isFinite(uic)) url.searchParams.set("Uic", String(Math.trunc(uic)));
  put("Symbol", symbol);
  return url.toString();
}

/** Short label describing where the link goes, for tooltips/aria text. */
export function saxoDeepLinkLabel(env: SaxoEnv): string {
  return env === "live"
    ? "Open in SaxoTraderGO (live)"
    : "Open in SaxoTraderGO (simulation)";
}
