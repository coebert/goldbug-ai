import { describe, expect, it } from "vitest";
import {
  buildSaxoCorporateActionLink,
  saxoCorporateActionsBase,
  saxoDeepLinkLabel,
} from "../saxo-deep-link";

describe("saxo deep link", () => {
  it("uses the live workspace only for live", () => {
    expect(saxoCorporateActionsBase("live")).toBe(
      "https://www.saxotrader.com/d/corporateactions",
    );
    expect(saxoCorporateActionsBase("sim")).toBe(
      "https://www.saxotrader.com/sim/d/corporateactions",
    );
    expect(saxoCorporateActionsBase(null)).toBe(saxoCorporateActionsBase("sim"));
  });

  it("attaches available identifiers", () => {
    const url = new URL(
      buildSaxoCorporateActionLink({
        env: "live",
        accountKey: "ACC-1",
        eventId: "EV-9",
        uic: 1234,
        symbol: "ULVR:xlon",
      }),
    );
    expect(url.pathname).toBe("/d/corporateactions");
    expect(url.searchParams.get("AccountKey")).toBe("ACC-1");
    expect(url.searchParams.get("EventId")).toBe("EV-9");
    expect(url.searchParams.get("Uic")).toBe("1234");
    expect(url.searchParams.get("Symbol")).toBe("ULVR:xlon");
  });

  it("drops blank and invalid values instead of emitting empty params", () => {
    const url = buildSaxoCorporateActionLink({
      env: "sim",
      accountKey: "   ",
      eventId: null,
      uic: Number.NaN,
      symbol: undefined,
    });
    expect(url).toBe("https://www.saxotrader.com/sim/d/corporateactions");
  });

  it("truncates fractional uics", () => {
    expect(buildSaxoCorporateActionLink({ env: "sim", uic: 42.7 })).toContain("Uic=42");
  });

  it("labels the environment", () => {
    expect(saxoDeepLinkLabel("live")).toMatch(/live/);
    expect(saxoDeepLinkLabel(null)).toMatch(/simulation/);
  });
});
