import { describe, it, expect } from "vitest";
import {
  blockSymbolKey,
  classifyBrokerBlock,
  isSymbolBlocked,
} from "../broker-instrument-blocks";

const SAXO_SUITABILITY =
  "The order has been rejected because the instrument is not currently suitable for you or because a suitability test has not been taken.";

describe("classifyBrokerBlock", () => {
  it("blocks the observed Saxo suitability rejection", () => {
    const c = classifyBrokerBlock(SAXO_SUITABILITY);
    expect(c.block).toBe(true);
    expect(c.reason).toBe("suitability");
    expect(c.detail).toMatch(/suitability/i);
  });

  it("blocks on suitability error codes regardless of message", () => {
    expect(classifyBrokerBlock(null, "SuitabilityCheckFailed").reason).toBe("suitability");
    expect(classifyBrokerBlock(null, "instrumentnottradable").reason).toBe("not_tradable");
    expect(classifyBrokerBlock(null, "TradingNotAllowed").reason).toBe("not_permitted");
  });

  it("does not block transient/cash rejections", () => {
    for (const r of [
      "InsufficientCash",
      "Order rejected: market closed",
      "PriceOutsideRange",
      null,
      "",
    ]) {
      expect(classifyBrokerBlock(r).block).toBe(false);
    }
  });
});

describe("blockSymbolKey", () => {
  it("normalises engine and broker spellings to the same root", () => {
    expect(blockSymbolKey("SGLN.L")).toBe("SGLN");
    expect(blockSymbolKey("SGLN:xlon")).toBe("SGLN");
    expect(blockSymbolKey("sgln.l")).toBe("SGLN");
    expect(blockSymbolKey("AAPL")).toBe("AAPL");
    expect(blockSymbolKey("AAPL:xnas")).toBe("AAPL");
  });
});

describe("isSymbolBlocked", () => {
  it("matches across spellings and leaves others alone", () => {
    const blocked = ["SGLN.L"];
    expect(isSymbolBlocked("SGLN:xlon", blocked)).toBe(true);
    expect(isSymbolBlocked("SGLN.L", blocked)).toBe(true);
    expect(isSymbolBlocked("SGLD.L", blocked)).toBe(false);
    expect(isSymbolBlocked("AAPL", blocked)).toBe(false);
  });
});
