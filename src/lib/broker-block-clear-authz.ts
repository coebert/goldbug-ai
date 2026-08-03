// Pure authorization policy for clearing a learned broker instrument block.
//
// Unblocking a Saxo instrument re-enters it into the live trading universe,
// so it is a money-affecting action. The rules are deliberately explicit and
// unit-testable, separate from any transport (server fn or HTTP route):
//
//   1. The caller must present a valid session (authenticated + userId).
//   2. Second factor: once the account has a verified TOTP factor, the
//      session must be aal2 (same policy as `require-aal2`).
//   3. Ownership: a block row belongs to exactly one user. A caller may only
//      clear their own rows — admins included; there is no cross-user clear.
//   4. The block must actually exist and still be active, otherwise the
//      caller gets an unambiguous 404 instead of a silent success.

export type ClearAuthzInput = {
  authenticated: boolean;
  userId: string | null;
  /** `aal` claim from the verified access token. */
  aal: string | null;
  /** Whether the account has at least one verified MFA factor. */
  hasVerifiedFactor: boolean;
  /** Whether an active block row exists for (userId, broker, symbolKey). */
  blockExists: boolean;
  /** Owner of the block row, when it exists. */
  blockOwnerId: string | null;
};

export type ClearAuthzDenial = {
  ok: false;
  status: 401 | 403 | 404;
  code: "unauthenticated" | "mfa_required" | "forbidden" | "not_found";
  message: string;
};

export type ClearAuthzResult = { ok: true } | ClearAuthzDenial;

export function authorizeClearBrokerBlock(
  input: ClearAuthzInput,
): ClearAuthzResult {
  if (!input.authenticated || !input.userId) {
    return {
      ok: false,
      status: 401,
      code: "unauthenticated",
      message: "Sign in to unblock instruments.",
    };
  }

  if (input.hasVerifiedFactor && input.aal !== "aal2") {
    return {
      ok: false,
      status: 403,
      code: "mfa_required",
      message: "Two-factor verification required to unblock an instrument.",
    };
  }

  if (!input.blockExists) {
    return {
      ok: false,
      status: 404,
      code: "not_found",
      message: "No active block found for that instrument.",
    };
  }

  if (input.blockOwnerId && input.blockOwnerId !== input.userId) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: "You can only unblock instruments on your own account.",
    };
  }

  return { ok: true };
}
