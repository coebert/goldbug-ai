// Contract for the shared navigation registry.
//
// The registry is the single source of truth behind the mobile tab
// bar, the More sheet, the desktop rail and the header nav row. Two
// things must stay true or the app grows orphan routes again:
//   1. every real page under src/routes is reachable from the sheet
//      (directly, or through a hub page listed here);
//   2. exactly five destinations are marked primary — the tab bar and
//      rail are laid out for five.

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AREAS,
  DESTINATIONS,
  PRIMARY,
  areaForPath,
  searchDestinations,
} from "../destinations";

/** Routes that are intentionally not navigation destinations. */
const NON_DESTINATIONS = new Set([
  "__root",
  "auth", // reached by signing out
  "index", // "/" is listed explicitly
  "api",
  "README.md",
  "__tests__",
  // Detail pages reached from a parent listing, not from global nav.
  "portfolio.$id",
  "market.$symbol",
  "long-horizon.$id",
  "walk-forward.$id",
  "markets",
  "research",
]);

function routeSlugs(): string[] {
  return readdirSync("src/routes")
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => f.replace(/\.tsx$/, ""))
    .filter((slug) => !slug.startsWith("portfolio.$id."))
    .filter((slug) => !NON_DESTINATIONS.has(slug));
}

describe("navigation registry", () => {
  it("exposes exactly five primary destinations, one per area", () => {
    expect(PRIMARY).toHaveLength(5);
    expect(new Set(PRIMARY.map((d) => d.area)).size).toBe(5);
    expect(AREAS).toHaveLength(5);
  });

  it("lists every navigable route", () => {
    const listed = new Set(DESTINATIONS.map((d) => d.to.replace(/^\//, "")));
    const missing = routeSlugs().filter((slug) => !listed.has(slug));
    expect(missing).toEqual([]);
  });

  it("has no duplicate paths and gives every entry a plain-English hint", () => {
    const paths = DESTINATIONS.map((d) => d.to);
    expect(new Set(paths).size).toBe(paths.length);
    for (const d of DESTINATIONS) {
      expect(d.hint.length).toBeGreaterThan(10);
      expect(d.label.length).toBeGreaterThan(0);
    }
  });

  it("search matches on label, keyword and path", () => {
    expect(searchDestinations("stamp").length).toBe(0);
    expect(searchDestinations("saxo").map((d) => d.to)).toContain("/saxo-status");
    expect(searchDestinations("backtest").map((d) => d.to)).toContain("/research");
    expect(searchDestinations("").length).toBe(DESTINATIONS.length);
  });

  it("maps deep paths back to their top-level area", () => {
    expect(areaForPath("/")).toBe("home");
    expect(areaForPath("/market/AAPL")).toBe("markets");
    expect(areaForPath("/spillover")).toBe("markets");
    expect(areaForPath("/walk-forward/abc")).toBe("research");
    expect(areaForPath("/trades")).toBe("trades");
    expect(areaForPath("/broker-blocks")).toBe("system");
    expect(areaForPath("/settings")).toBe("system");
  });
});
