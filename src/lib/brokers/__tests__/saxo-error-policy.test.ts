import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  DEFAULT_SAXO_ERROR_POLICY,
  classifySaxoError,
  extractSaxoErrorInfo,
  getSaxoErrorPolicy,
  mergeSaxoErrorPolicy,
  parseSaxoErrorPolicyOverride,
} from "../saxo-error-policy";

describe("saxo-error-policy", () => {
  describe("classifySaxoError", () => {
    it("returns default outcome when errorCode is missing", () => {
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, null)).toBe("rejected");
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, undefined)).toBe("rejected");
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "")).toBe("rejected");
    });

    it("matches known business rejections silently", () => {
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "InsufficientCash")).toBe("rejected");
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "MarketClosed")).toBe("rejected");
    });

    it("surfaces true system errors loudly", () => {
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "InvalidRequest")).toBe("error");
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "Unauthorized")).toBe("error");
    });

    it("flags throttling as retry", () => {
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "Throttled")).toBe("retry");
    });

    it("is case-insensitive on the error code", () => {
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "insufficientcash")).toBe("rejected");
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "INVALIDREQUEST")).toBe("error");
    });

    it("falls back to defaultOutcome for unknown codes", () => {
      expect(classifySaxoError(DEFAULT_SAXO_ERROR_POLICY, "SomeBrandNewCode")).toBe("rejected");
      const strict = mergeSaxoErrorPolicy(DEFAULT_SAXO_ERROR_POLICY, { defaultOutcome: "error" });
      expect(classifySaxoError(strict, "SomeBrandNewCode")).toBe("error");
    });
  });

  describe("parseSaxoErrorPolicyOverride", () => {
    it("returns empty override for missing/blank input", () => {
      expect(parseSaxoErrorPolicyOverride(undefined)).toEqual({});
      expect(parseSaxoErrorPolicyOverride("")).toEqual({});
    });

    it("ignores malformed JSON without throwing", () => {
      expect(parseSaxoErrorPolicyOverride("{not-json")).toEqual({});
    });

    it("accepts the full { default, codes } shape", () => {
      const o = parseSaxoErrorPolicyOverride(
        JSON.stringify({ default: "error", codes: { InsufficientCash: "error" } }),
      );
      expect(o.defaultOutcome).toBe("error");
      expect(o.codes).toEqual({ InsufficientCash: "error" });
    });

    it("accepts a flat code map without a `codes` wrapper", () => {
      const o = parseSaxoErrorPolicyOverride(
        JSON.stringify({ InsufficientCash: "error", MarketClosed: "retry" }),
      );
      expect(o.codes).toEqual({ InsufficientCash: "error", MarketClosed: "retry" });
    });

    it("rejects invalid outcome values", () => {
      const o = parseSaxoErrorPolicyOverride(
        JSON.stringify({ default: "banana", codes: { X: "explode", Y: "rejected" } }),
      );
      expect(o.defaultOutcome).toBeUndefined();
      expect(o.codes).toEqual({ Y: "rejected" });
    });
  });

  describe("mergeSaxoErrorPolicy", () => {
    it("layers override codes on top of the baseline", () => {
      const merged = mergeSaxoErrorPolicy(DEFAULT_SAXO_ERROR_POLICY, {
        codes: { InsufficientCash: "error", BrandNew: "rejected" },
      });
      expect(merged.codes.InsufficientCash).toBe("error");
      expect(merged.codes.MarketClosed).toBe("rejected"); // preserved from baseline
      expect(merged.codes.BrandNew).toBe("rejected");
    });
  });

  describe("extractSaxoErrorInfo", () => {
    it("pulls ErrorCode and Message out of a req() error string", () => {
      const raw =
        'Saxo POST /trade/v2/orders failed [400]: {"ErrorInfo":{"ErrorCode":"InsufficientCash","Message":"Not enough cash"}}';
      expect(extractSaxoErrorInfo(raw)).toEqual({
        code: "InsufficientCash",
        message: "Not enough cash",
      });
    });

    it("returns nulls when there is no JSON payload", () => {
      expect(extractSaxoErrorInfo("Saxo POST failed: network timeout")).toEqual({
        code: null,
        message: null,
      });
    });
  });

  describe("getSaxoErrorPolicy (env-driven)", () => {
    const original = process.env.SAXO_ERROR_POLICY_JSON;
    beforeEach(() => {
      delete process.env.SAXO_ERROR_POLICY_JSON;
    });
    afterEach(() => {
      if (original === undefined) delete process.env.SAXO_ERROR_POLICY_JSON;
      else process.env.SAXO_ERROR_POLICY_JSON = original;
    });

    it("returns the baseline when env is unset", () => {
      expect(getSaxoErrorPolicy().codes.InsufficientCash).toBe("rejected");
    });

    it("applies env-based overrides", () => {
      process.env.SAXO_ERROR_POLICY_JSON = JSON.stringify({
        codes: { InsufficientCash: "error" },
      });
      const p = getSaxoErrorPolicy();
      expect(p.codes.InsufficientCash).toBe("error");
      expect(p.codes.MarketClosed).toBe("rejected"); // baseline preserved
    });
  });
});
