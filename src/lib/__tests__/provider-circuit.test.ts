import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runWithBreaker,
  CircuitOpenError,
  resetCircuit,
  circuitSnapshot,
} from "@/lib/_server/provider-circuit";

describe("provider circuit breaker", () => {
  beforeEach(() => {
    resetCircuit();
  });

  it("passes through successful calls and resets failures", async () => {
    const r = await runWithBreaker("yahoo", async () => 42, { failureThreshold: 2 });
    expect(r).toBe(42);
    expect(circuitSnapshot().yahoo.failures).toBe(0);
  });

  it("opens after threshold consecutive failures", async () => {
    const call = () =>
      runWithBreaker("gdelt", async () => {
        throw new Error("boom");
      }, { failureThreshold: 3, cooldownMs: 1000 });

    await expect(call()).rejects.toThrow("boom");
    await expect(call()).rejects.toThrow("boom");
    await expect(call()).rejects.toThrow("boom");

    // Now open — next call must fail fast without invoking the fn.
    const spy = vi.fn(async () => "ok");
    await expect(
      runWithBreaker("gdelt", spy, { failureThreshold: 3, cooldownMs: 1000 }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows a half-open probe after cooldown and closes on success", async () => {
    vi.useFakeTimers();
    try {
      const bad = () =>
        runWithBreaker("saxo", async () => {
          throw new Error("nope");
        }, { failureThreshold: 2, cooldownMs: 500 });

      await expect(bad()).rejects.toThrow();
      await expect(bad()).rejects.toThrow();
      expect(circuitSnapshot().saxo.open).toBe(true);

      vi.advanceTimersByTime(600);
      const probe = await runWithBreaker("saxo", async () => "ok", {
        failureThreshold: 2,
        cooldownMs: 500,
      });
      expect(probe).toBe("ok");
      expect(circuitSnapshot().saxo.open).toBe(false);
      expect(circuitSnapshot().saxo.failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open if failures stay below threshold", async () => {
    await expect(
      runWithBreaker("ai", async () => { throw new Error("x"); }, { failureThreshold: 5 }),
    ).rejects.toThrow();
    await expect(
      runWithBreaker("ai", async () => "ok", { failureThreshold: 5 }),
    ).resolves.toBe("ok");
    expect(circuitSnapshot().ai.open).toBe(false);
    expect(circuitSnapshot().ai.failures).toBe(0);
  });
});
