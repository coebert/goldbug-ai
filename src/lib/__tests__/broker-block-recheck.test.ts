import { describe, it, expect } from "vitest";
import { decideRecheck, summariseRecheck } from "../broker-block-recheck";

describe("decideRecheck", () => {
  it("clears when the broker precheck passes", () => {
    expect(decideRecheck({ ok: true }).outcome).toBe("cleared");
  });

  it("keeps the block when the same suitability refusal returns", () => {
    const d = decideRecheck({
      ok: false,
      message:
        "The order has been rejected because the instrument is not currently suitable for you or because a suitability test has not been taken.",
    });
    expect(d.outcome).toBe("blocked");
  });

  it("clears when the rejection is order-specific (cash, market closed)", () => {
    expect(decideRecheck({ ok: false, errorCode: "InsufficientCash" }).outcome).toBe("cleared");
    expect(decideRecheck({ ok: false, message: "Market is closed" }).outcome).toBe("cleared");
  });

  it("leaves the block untouched when the probe itself failed", () => {
    expect(decideRecheck({ ok: false, failed: true }).outcome).toBe("unknown");
  });
});

describe("summariseRecheck", () => {
  it("summarises mixed outcomes", () => {
    const s = summariseRecheck([
      { symbol: "SGLN.L", symbolKey: "SGLN", outcome: "cleared", note: "" },
      { symbol: "XUKS.L", symbolKey: "XUKS", outcome: "blocked", note: "" },
      { symbol: "XSPS.L", symbolKey: "XSPS", outcome: "unknown", note: "" },
    ]);
    expect(s).toMatchObject({ checked: 3, cleared: 1, stillBlocked: 1, unknown: 1 });
    expect(s.message).toContain("1 unblocked");
  });

  it("handles the empty case", () => {
    expect(summariseRecheck([]).message).toMatch(/No blocked instruments/);
  });
});
