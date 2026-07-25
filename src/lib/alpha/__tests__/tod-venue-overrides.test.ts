// Per-venue TOD override behaviour: verifies `resolveVenueTodConfig` merges
// defaults with per-venue tuning and that `todExecutionAdjustment` honours
// custom session bounds (early close, extended open) in addition to the
// per-venue auction/haircut knobs.

import { describe, it, expect } from "vitest";
import {
  resolveVenueTodConfig,
  todExecutionAdjustment,
} from "../execution-alpha";
import { parseRiskConfig, DEFAULT_RISK_CONFIG } from "../../universe.server";

const DEFAULTS = {
  avoidOpenMin: 15,
  avoidCloseMin: 15,
  openHaircut: 0.5,
  closeHaircut: 0.5,
  hardBlockOpenMin: 5,
  hardBlockCloseMin: 5,
} as const;

// Winter UTC → London local hour equals UTC hour.
const lseAt = (h: number, m: number) => new Date(Date.UTC(2025, 0, 15, h, m, 0));
// Winter EST (UTC-5) → NY local hour equals UTC hour minus 5.
const nyAt = (h: number, m: number) => new Date(Date.UTC(2025, 0, 15, h + 5, m, 0));

describe("resolveVenueTodConfig", () => {
  it("returns defaults verbatim when no override present", () => {
    const r = resolveVenueTodConfig(DEFAULTS, "LSE", null);
    expect(r).toEqual({ ...DEFAULTS, sessionOpenMin: undefined, sessionCloseMin: undefined });
  });

  it("returns defaults when overrides map has no entry for that venue", () => {
    const r = resolveVenueTodConfig(DEFAULTS, "NYSE", { LSE: { openHaircut: 0.1 } });
    expect(r.openHaircut).toBe(DEFAULTS.openHaircut);
  });

  it("merges partial override — only fields present are overridden", () => {
    const r = resolveVenueTodConfig(DEFAULTS, "LSE", {
      LSE: { hardBlockOpenMin: 10, openHaircut: 0.2 },
    });
    expect(r.hardBlockOpenMin).toBe(10);
    expect(r.openHaircut).toBe(0.2);
    // Untouched fields remain at defaults
    expect(r.avoidOpenMin).toBe(DEFAULTS.avoidOpenMin);
    expect(r.closeHaircut).toBe(DEFAULTS.closeHaircut);
    expect(r.hardBlockCloseMin).toBe(DEFAULTS.hardBlockCloseMin);
  });

  it("passes through custom session bounds", () => {
    const r = resolveVenueTodConfig(DEFAULTS, "LSE", {
      LSE: { sessionOpenMin: 9 * 60, sessionCloseMin: 12 * 60 + 30 }, // early close
    });
    expect(r.sessionOpenMin).toBe(540);
    expect(r.sessionCloseMin).toBe(750);
  });
});

describe("todExecutionAdjustment with per-venue overrides", () => {
  it("custom LSE early close (12:30) treats 13:00 as outside-RTH batch", () => {
    const cfg = resolveVenueTodConfig(DEFAULTS, "LSE", {
      LSE: { sessionOpenMin: 8 * 60, sessionCloseMin: 12 * 60 + 30 },
    });
    const r = todExecutionAdjustment({ venue: "LSE", ...cfg, now: lseAt(13, 0) });
    expect(r.allow).toBe(true);
    expect(r.reason).toMatch(/outside RTH/i);
  });

  it("custom LSE early close hard-blocks the last 5m of the shortened session", () => {
    const cfg = resolveVenueTodConfig(DEFAULTS, "LSE", {
      LSE: { sessionOpenMin: 8 * 60, sessionCloseMin: 12 * 60 + 30 },
    });
    // 12:28 is 2m before the custom 12:30 close → hard block.
    const r = todExecutionAdjustment({ venue: "LSE", ...cfg, now: lseAt(12, 28) });
    expect(r.allow).toBe(false);
    expect(r.multiplier).toBe(0);
    expect(r.reason).toMatch(/hard-block last/i);
  });

  it("per-venue haircut override takes effect (LSE tightened to 0.2)", () => {
    const cfg = resolveVenueTodConfig(DEFAULTS, "LSE", {
      LSE: { openHaircut: 0.2, hardBlockOpenMin: 0 },
    });
    // 08:07 is 7m past open, still inside the 15m avoid window → haircut fires.
    const r = todExecutionAdjustment({ venue: "LSE", ...cfg, now: lseAt(8, 7) });
    expect(r.allow).toBe(true);
    expect(r.multiplier).toBeCloseTo(0.2, 6);
  });

  it("NYSE override does not bleed into LSE resolution", () => {
    const overrides = { NYSE: { openHaircut: 0.1, hardBlockOpenMin: 20 } };
    const lseCfg = resolveVenueTodConfig(DEFAULTS, "LSE", overrides);
    const nyCfg = resolveVenueTodConfig(DEFAULTS, "NYSE", overrides);
    // LSE at 08:07 → default 0.5 haircut, no extended block.
    const lseRes = todExecutionAdjustment({ venue: "LSE", ...lseCfg, now: lseAt(8, 7) });
    expect(lseRes.multiplier).toBeCloseTo(0.5, 6);
    // NYSE at 09:45 → within the tightened 20m hard-block window.
    const nyRes = todExecutionAdjustment({ venue: "NYSE", ...nyCfg, now: nyAt(9, 45) });
    expect(nyRes.allow).toBe(false);
    expect(nyRes.reason).toMatch(/hard-block first 20m/i);
  });

  it("relaxing hard-block to 0 lets a window that would block become a haircut", () => {
    const base = todExecutionAdjustment({ venue: "LSE", ...DEFAULTS, now: lseAt(8, 2) });
    expect(base.allow).toBe(false); // default 5m block
    const cfg = resolveVenueTodConfig(DEFAULTS, "LSE", {
      LSE: { hardBlockOpenMin: 0 },
    });
    const relaxed = todExecutionAdjustment({ venue: "LSE", ...cfg, now: lseAt(8, 2) });
    expect(relaxed.allow).toBe(true);
    expect(relaxed.multiplier).toBeCloseTo(DEFAULTS.openHaircut, 6);
  });
});

describe("parseRiskConfig — tod_venue_overrides", () => {
  it("defaults to null when unset", () => {
    expect(parseRiskConfig({}).tod_venue_overrides).toBeNull();
    expect(DEFAULT_RISK_CONFIG.tod_venue_overrides).toBeNull();
  });

  it("accepts a valid partial override map and clamps values", () => {
    const parsed = parseRiskConfig({
      tod_venue_overrides: {
        LSE: {
          openHaircut: 0.25,
          hardBlockOpenMin: 8,
          sessionOpenMin: 480,
          sessionCloseMin: 750,
        },
        NYSE: { closeHaircut: 0.3 },
      },
    });
    expect(parsed.tod_venue_overrides).toEqual({
      LSE: { openHaircut: 0.25, hardBlockOpenMin: 8, sessionOpenMin: 480, sessionCloseMin: 750 },
      NYSE: { closeHaircut: 0.3 },
    });
  });

  it("clamps out-of-range values into legal bounds", () => {
    const parsed = parseRiskConfig({
      tod_venue_overrides: {
        LSE: { openHaircut: 5, hardBlockOpenMin: 999, sessionOpenMin: -100 },
      },
    });
    const lse = parsed.tod_venue_overrides!.LSE!;
    expect(lse.openHaircut).toBe(1); // clamped to [0,1]
    expect(lse.hardBlockOpenMin).toBe(120); // clamped to [0,120]
    expect(lse.sessionOpenMin).toBe(0); // clamped to [0, 1440]
  });

  it("drops unknown venues and non-object entries", () => {
    const parsed = parseRiskConfig({
      tod_venue_overrides: {
        FOO: { openHaircut: 0.3 },
        LSE: "nope",
        NYSE: { openHaircut: 0.4 },
      },
    });
    expect(parsed.tod_venue_overrides).toEqual({ NYSE: { openHaircut: 0.4 } });
  });

  it("returns null when every entry has zero valid fields", () => {
    const parsed = parseRiskConfig({
      tod_venue_overrides: { LSE: { openHaircut: "banana" } },
    });
    expect(parsed.tod_venue_overrides).toBeNull();
  });
});
