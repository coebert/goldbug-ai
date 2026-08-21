// Validating the configured Saxo account key against the broker environment.
//
// BUG THIS EXISTS TO PREVENT: `SAXO_ACCOUNT_KEY` is a process-wide env var, but
// account keys are environment-specific — a key minted on SIM does not exist on
// LIVE and vice versa. The adapter used to accept the configured key blindly
// and, when it did not appear in `/port/v1/accounts/me`, silently swap in "the
// first active account it could find". That produced runs that traded a
// different account than the one that was configured, and one identical error
// row per broker call.
//
// The rule now: a configured key is only used when the broker environment
// confirms it exists AND is active. Otherwise we fall back explicitly, report a
// typed status, and log the mismatch once per (env, key) instead of every call.

export type SaxoAccountSummary = {
  AccountKey?: string;
  Active?: boolean;
  Currency?: string;
  LegalAssetTypes?: string[];
};

export type SaxoAccountKeyStatus =
  /** Configured key exists and is active in this environment. */
  | "valid"
  /** Configured key exists but the broker marks it inactive. */
  | "inactive"
  /** Configured key is absent from this environment's account list. */
  | "wrong_environment"
  /** No key was configured; one was discovered. */
  | "discovered"
  /** Nothing configured and nothing usable discovered. */
  | "unavailable";

export type SaxoAccountKeyResolution = {
  accountKey: string | undefined;
  status: SaxoAccountKeyStatus;
  /** True when the configured key was rejected and a different one is in use. */
  mismatch: boolean;
  configured: string | undefined;
  accountCount: number;
  message: string;
};

function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  return key.length <= 8 ? `${key.slice(0, 2)}…` : `${key.slice(0, 6)}…${key.slice(-2)}`;
}

function pickTradable(accounts: SaxoAccountSummary[]): SaxoAccountSummary | undefined {
  return (
    accounts.find(
      (a) => a.Active !== false && a.AccountKey && a.LegalAssetTypes?.some((t) => t === "Stock" || t === "Etf"),
    ) ??
    accounts.find((a) => a.Active !== false && a.AccountKey) ??
    accounts.find((a) => a.AccountKey)
  );
}

/**
 * Decide which account key to use for a broker environment.
 * Pure: takes the accounts the broker reported and the configured key.
 */
export function resolveSaxoAccountKey(args: {
  env: string;
  configured?: string | null;
  accounts: SaxoAccountSummary[];
}): SaxoAccountKeyResolution {
  const configured = (args.configured ?? "").trim() || undefined;
  const accounts = args.accounts.filter((a) => !!a?.AccountKey);
  const accountCount = accounts.length;
  const match = configured ? accounts.find((a) => a.AccountKey === configured) : undefined;
  const fallback = pickTradable(accounts)?.AccountKey;

  if (configured && match && match.Active !== false) {
    return {
      accountKey: configured,
      status: "valid",
      mismatch: false,
      configured,
      accountCount,
      message: `Configured account ${maskKey(configured)} validated against ${args.env}.`,
    };
  }

  if (configured && match) {
    return {
      accountKey: fallback,
      status: "inactive",
      mismatch: true,
      configured,
      accountCount,
      message:
        `Configured account ${maskKey(configured)} exists on ${args.env} but is inactive; ` +
        `using ${maskKey(fallback)} instead.`,
    };
  }

  if (configured) {
    return {
      accountKey: fallback,
      status: "wrong_environment",
      mismatch: true,
      configured,
      accountCount,
      message:
        `Configured SAXO_ACCOUNT_KEY ${maskKey(configured)} does not exist in the ${args.env} ` +
        `environment (${accountCount} account(s) visible); using ${maskKey(fallback)} instead.`,
    };
  }

  if (fallback) {
    return {
      accountKey: fallback,
      status: "discovered",
      mismatch: false,
      configured: undefined,
      accountCount,
      message: `No SAXO_ACCOUNT_KEY configured; discovered ${maskKey(fallback)} on ${args.env}.`,
    };
  }

  return {
    accountKey: undefined,
    status: "unavailable",
    mismatch: false,
    configured,
    accountCount,
    message: `No usable Saxo account found in the ${args.env} environment.`,
  };
}

// Log-once bookkeeping so a mismatch produces a single broker-log row per
// process per (env, configured key) rather than one per API call.
const reported = new Set<string>();

export function shouldReportAccountKeyIssue(env: string, resolution: SaxoAccountKeyResolution): boolean {
  if (!resolution.mismatch && resolution.status !== "unavailable") return false;
  const key = `${env}:${resolution.configured ?? ""}:${resolution.status}`;
  if (reported.has(key)) return false;
  reported.add(key);
  return true;
}

/** Test seam. */
export function __resetAccountKeyReporting(): void {
  reported.clear();
}
