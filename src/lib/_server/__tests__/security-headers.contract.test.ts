/**
 * CI contract: the browser security policy shipped on every SSR response.
 *
 * This is a *lock*, not a description. If a change here is deliberate, update
 * the expectations in the same commit so the loosening is reviewable.
 */
import { describe, expect, it } from "vitest";

import {
  applySecurityHeaders,
  CSP,
  CSP_DIRECTIVES,
  SECURITY_HEADERS,
} from "../security-headers";

const directive = (name: string) =>
  CSP_DIRECTIVES.find((d) => d.split(" ")[0] === name);

describe("security headers contract", () => {
  it("ships every required header", () => {
    for (const name of [
      "content-security-policy",
      "x-content-type-options",
      "referrer-policy",
      "permissions-policy",
      "cross-origin-opener-policy",
      "strict-transport-security",
    ]) {
      expect(SECURITY_HEADERS[name], `missing ${name}`).toBeTruthy();
    }
  });

  it("keeps HSTS at a year with subdomains", () => {
    const hsts = SECURITY_HEADERS["strict-transport-security"];
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain("includeSubDomains");
  });

  it("pins the anti-clickjacking and injection directives", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(directive("frame-ancestors")).toBeTruthy();
    expect(directive("frame-ancestors")).not.toContain("*;");
    expect(directive("frame-ancestors")).not.toMatch(/\s\*$/);
  });

  it("never allows a wildcard script or connect source", () => {
    for (const name of ["script-src", "style-src", "connect-src", "default-src"]) {
      const value = directive(name) ?? "";
      expect(value.split(/\s+/), `${name} allows *`).not.toContain("*");
      expect(value, `${name} allows http:`).not.toMatch(/\shttp:/);
    }
  });

  it("keeps nosniff and a privacy-preserving referrer policy", () => {
    expect(SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(
      ["strict-origin-when-cross-origin", "no-referrer", "same-origin"],
    ).toContain(SECURITY_HEADERS["referrer-policy"]);
  });

  it("denies camera, microphone, geolocation and payment", () => {
    const policy = SECURITY_HEADERS["permissions-policy"];
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it("applies to a response without overwriting explicit values", () => {
    const headers = new Headers({ "referrer-policy": "no-referrer" });
    applySecurityHeaders(headers);
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("content-security-policy")).toBe(CSP);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });
});
