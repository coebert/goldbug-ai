import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, logSecurity } from "@/lib/_server/log";

afterEach(() => vi.restoreAllMocks());

function parseTrailingJson(call: unknown[]): Record<string, unknown> {
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

describe("structured logger", () => {
  it("emits a single line with prefix and JSON payload", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = createLogger("news:gdelt");
    log.warn("fetch failed", { status: 429, symbol: "AAPL" });

    expect(spy).toHaveBeenCalledTimes(1);
    const text = spy.mock.calls[0][0] as string;
    expect(text).toBe("news:gdelt fetch failed");
    const payload = parseTrailingJson(spy.mock.calls[0]);
    expect(payload.prefix).toBe("news:gdelt");
    expect(payload.level).toBe("warn");
    expect(payload.msg).toBe("fetch failed");
    expect(payload.status).toBe(429);
    expect(payload.symbol).toBe("AAPL");
    expect(typeof payload.ts).toBe("string");
  });

  it("serialises Error instances into message/name/stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("saxo");
    log.error("place order failed", { err: new Error("bad request") });

    const payload = parseTrailingJson(spy.mock.calls[0]);
    const err = payload.err as { message: string; name: string };
    expect(err.message).toBe("bad request");
    expect(err.name).toBe("Error");
  });

  it("logSecurity uses the SECURITY: prefix expected by ops greps", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSecurity("pending_slices", "unexpected access attempt", { userId: "u1" });

    const text = spy.mock.calls[0][0] as string;
    expect(text).toBe("SECURITY:pending_slices unexpected access attempt");
    const payload = parseTrailingJson(spy.mock.calls[0]);
    expect(payload.prefix).toBe("SECURITY:pending_slices");
    expect(payload.userId).toBe("u1");
  });
});
