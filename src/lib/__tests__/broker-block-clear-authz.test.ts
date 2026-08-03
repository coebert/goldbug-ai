import { describe, expect, it } from "vitest";
import { authorizeClearBrokerBlock } from "@/lib/broker-block-clear-authz";

const base = {
  authenticated: true,
  userId: "user-1",
  aal: "aal2" as string | null,
  hasVerifiedFactor: true,
  blockExists: true,
  blockOwnerId: "user-1" as string | null,
};

describe("authorizeClearBrokerBlock", () => {
  it("allows the owner with a second factor", () => {
    expect(authorizeClearBrokerBlock(base)).toEqual({ ok: true });
  });

  it("rejects anonymous callers with 401", () => {
    const r = authorizeClearBrokerBlock({ ...base, authenticated: false, userId: null });
    expect(r).toMatchObject({ ok: false, status: 401, code: "unauthenticated" });
  });

  it("rejects an aal1 session once a factor is enrolled", () => {
    const r = authorizeClearBrokerBlock({ ...base, aal: "aal1" });
    expect(r).toMatchObject({ ok: false, status: 403, code: "mfa_required" });
  });

  it("allows aal1 when no factor is enrolled yet", () => {
    expect(
      authorizeClearBrokerBlock({ ...base, aal: "aal1", hasVerifiedFactor: false }),
    ).toEqual({ ok: true });
  });

  it("returns 404 when no active block matches", () => {
    const r = authorizeClearBrokerBlock({ ...base, blockExists: false, blockOwnerId: null });
    expect(r).toMatchObject({ ok: false, status: 404, code: "not_found" });
  });

  it("refuses to clear another user's block", () => {
    const r = authorizeClearBrokerBlock({ ...base, blockOwnerId: "user-2" });
    expect(r).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  it("checks auth before existence (no block enumeration for anon)", () => {
    const r = authorizeClearBrokerBlock({
      ...base,
      authenticated: false,
      userId: null,
      blockExists: false,
    });
    expect(r).toMatchObject({ code: "unauthenticated" });
  });
});
