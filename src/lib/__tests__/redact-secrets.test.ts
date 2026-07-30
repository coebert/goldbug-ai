import { describe, it, expect } from "vitest";
import { redactedError } from "@/lib/_server/redact";

describe("redactedError", () => {
  it("strips bearer, jwt and kv secrets", () => {
    const m = redactedError(
      new Error('failed Bearer abc.def refresh_token=SUPERSECRETVALUE "access_token":"eyJhbGciOiJIUzI1NiJ9.payload.sig"'),
    ).message;
    expect(m).not.toContain("SUPERSECRETVALUE");
    expect(m).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(m).toContain("Bearer [redacted]");
  });
  it("keeps short human text readable", () => {
    expect(redactedError(new Error("Saxo token exchange failed (401)")).message).toContain("401");
  });
});
