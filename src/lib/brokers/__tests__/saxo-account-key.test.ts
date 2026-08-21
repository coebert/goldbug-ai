import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveSaxoAccountKey,
  shouldReportAccountKeyIssue,
  __resetAccountKeyReporting,
} from "../saxo-account-key";

const stock = (key: string, active = true) => ({
  AccountKey: key,
  Active: active,
  LegalAssetTypes: ["Stock", "Etf"],
});

describe("resolveSaxoAccountKey", () => {
  beforeEach(() => __resetAccountKeyReporting());

  it("accepts a configured key that exists and is active", () => {
    const r = resolveSaxoAccountKey({ env: "live", configured: "AAA", accounts: [stock("AAA"), stock("BBB")] });
    expect(r).toMatchObject({ accountKey: "AAA", status: "valid", mismatch: false });
  });

  it("flags a key from the wrong environment and falls back to a tradable account", () => {
    const r = resolveSaxoAccountKey({ env: "sim", configured: "LIVEKEY", accounts: [stock("SIMKEY")] });
    expect(r.status).toBe("wrong_environment");
    expect(r.mismatch).toBe(true);
    expect(r.accountKey).toBe("SIMKEY");
    expect(r.message).toContain("sim");
  });

  it("does not leak the full configured key in the message", () => {
    const r = resolveSaxoAccountKey({ env: "sim", configured: "SECRETACCOUNTKEY", accounts: [stock("SIMKEY")] });
    expect(r.message).not.toContain("SECRETACCOUNTKEY");
  });

  it("treats an inactive configured account as a mismatch", () => {
    const r = resolveSaxoAccountKey({
      env: "live",
      configured: "AAA",
      accounts: [stock("AAA", false), stock("BBB")],
    });
    expect(r.status).toBe("inactive");
    expect(r.accountKey).toBe("BBB");
  });

  it("prefers stock/etf-capable accounts when discovering", () => {
    const r = resolveSaxoAccountKey({
      env: "sim",
      accounts: [{ AccountKey: "FX", Active: true, LegalAssetTypes: ["FxSpot"] }, stock("EQ")],
    });
    expect(r).toMatchObject({ accountKey: "EQ", status: "discovered", mismatch: false });
  });

  it("reports unavailable when the environment exposes no accounts", () => {
    const r = resolveSaxoAccountKey({ env: "live", configured: "AAA", accounts: [] });
    expect(r.status).toBe("wrong_environment");
    expect(r.accountKey).toBeUndefined();
  });

  it("reports unavailable with no configured key and no accounts", () => {
    const r = resolveSaxoAccountKey({ env: "live", accounts: [] });
    expect(r.status).toBe("unavailable");
  });

  it("ignores blank configured keys", () => {
    const r = resolveSaxoAccountKey({ env: "sim", configured: "   ", accounts: [stock("SIMKEY")] });
    expect(r.status).toBe("discovered");
    expect(r.mismatch).toBe(false);
  });
});

describe("shouldReportAccountKeyIssue", () => {
  beforeEach(() => __resetAccountKeyReporting());

  it("logs a mismatch once per env and key, not per call", () => {
    const r = resolveSaxoAccountKey({ env: "sim", configured: "LIVEKEY", accounts: [stock("SIMKEY")] });
    expect(shouldReportAccountKeyIssue("sim", r)).toBe(true);
    expect(shouldReportAccountKeyIssue("sim", r)).toBe(false);
    expect(shouldReportAccountKeyIssue("live", r)).toBe(true);
  });

  it("never logs a clean resolution", () => {
    const r = resolveSaxoAccountKey({ env: "sim", configured: "SIMKEY", accounts: [stock("SIMKEY")] });
    expect(shouldReportAccountKeyIssue("sim", r)).toBe(false);
  });
});
