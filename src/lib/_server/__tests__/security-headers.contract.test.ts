/**
 * CI contract: the browser security policy shipped on every SSR response.
 *
 * This is a *lock*, not a description. If a change here is deliberate, update
 * the expectations in the same commit so the loosening is reviewable.
 */
import { describe, expect, it } from "vitest";

import {
  API_CSP_DIRECTIVES,
  applySecurityHeaders,
  buildDocumentCsp,
  classifyEndpoint,
  CSP,
  CSP_DIRECTIVES,
  headersFor,
  SECURITY_HEADERS,
} from "../security-headers";

const get = (directives: readonly string[], name: string) =>
  directives.find((d) => d.split(" ")[0] === name);

const PROD = buildDocumentCsp(true);
const DEV = buildDocumentCsp(false);

describe("document security headers contract", () => {
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
    expect(get(CSP_DIRECTIVES, "default-src")).toBe("default-src 'self'");
    expect(get(CSP_DIRECTIVES, "base-uri")).toBe("base-uri 'self'");
    expect(get(CSP_DIRECTIVES, "object-src")).toBe("object-src 'none'");
    expect(get(CSP_DIRECTIVES, "frame-src")).toBe("frame-src 'none'");
    expect(get(CSP_DIRECTIVES, "form-action")).toBe("form-action 'self'");
    expect(get(CSP_DIRECTIVES, "frame-ancestors")).toBeTruthy();
    expect(get(CSP_DIRECTIVES, "frame-ancestors")).not.toMatch(/\s\*$/);
    expect(CSP_DIRECTIVES).toContain("upgrade-insecure-requests");
  });

  it("never allows a wildcard or plaintext source", () => {
    for (const name of ["script-src", "style-src", "connect-src", "img-src", "font-src", "default-src"]) {
      const value = get(PROD, name) ?? "";
      expect(value.split(/\s+/), `${name} allows *`).not.toContain("*");
      expect(value, `${name} allows http:`).not.toMatch(/\shttp:/);
    }
  });

  it("carries no eval and no editor origins in production", () => {
    const script = get(PROD, "script-src")!;
    expect(script).not.toContain("unsafe-eval");
    expect(script).not.toContain("lovable");
    // The Start runtime hydrates via an inline bootstrap script.
    expect(script).toContain("'unsafe-inline'");
    // Dev keeps the HMR concessions; that divergence is the point.
    expect(get(DEV, "script-src")).toContain("unsafe-eval");
  });

  it("scopes connect-src to same-origin plus the backend, not all of https", () => {
    const connect = get(PROD, "connect-src")!;
    expect(connect).toContain("'self'");
    expect(connect.split(/\s+/)).not.toContain("https:");
    expect(connect.split(/\s+/)).not.toContain("wss:");
    expect(connect).toMatch(/https:\/\/[^\s]*supabase/);
    expect(connect).toMatch(/wss:\/\/[^\s]*supabase/);
  });

  it("keeps img/font sources to what the app actually loads", () => {
    // data: is the MFA enrolment QR code; blob:/https: wildcards are unused.
    expect(get(PROD, "img-src")).toBe("img-src 'self' data:");
    expect(get(PROD, "font-src")).toBe("font-src 'self' https://fonts.gstatic.com");
  });

  it("declares no directive that merely repeats the default-src fallback", () => {
    const redundant = ["worker-src", "manifest-src", "media-src", "child-src", "script-src-elem"];
    for (const name of redundant) {
      expect(get(PROD, name), `${name} duplicates default-src 'self'`).toBeUndefined();
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
});

describe("per-endpoint policies", () => {
  it("classifies paths into the right policy", () => {
    expect(classifyEndpoint("/")).toBe("document");
    expect(classifyEndpoint("/portfolio/1")).toBe("document");
    expect(classifyEndpoint("/api/public/hooks/hourly")).toBe("api");
    expect(classifyEndpoint("/assets/app-abc123.js")).toBe("asset");
    expect(classifyEndpoint("/sw-push.js")).toBe("asset");
  });

  it("locks API responses down to default-src 'none'", () => {
    expect(API_CSP_DIRECTIVES).toContain("default-src 'none'");
    expect(API_CSP_DIRECTIVES).toContain("frame-ancestors 'none'");
    expect(API_CSP_DIRECTIVES).toContain("base-uri 'none'");
    expect(API_CSP_DIRECTIVES).toContain("form-action 'none'");
    const csp = headersFor("api")["content-security-policy"];
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("still sends transport headers on API and asset responses", () => {
    for (const kind of ["api", "asset"] as const) {
      const headers = headersFor(kind);
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["strict-transport-security"]).toContain("max-age=");
    }
  });

  it("does not waste document-only headers on non-document responses", () => {
    expect(headersFor("api")["permissions-policy"]).toBeUndefined();
    expect(headersFor("asset")["content-security-policy"]).toBeUndefined();
  });

  it("applies the matching policy per path and never overwrites explicit values", () => {
    const doc = new Headers();
    applySecurityHeaders(doc, "/dashboard");
    expect(doc.get("content-security-policy")).toBe(CSP);

    const api = new Headers();
    applySecurityHeaders(api, "/api/public/news-preview");
    expect(api.get("content-security-policy")).toContain("default-src 'none'");

    const override = new Headers({ "referrer-policy": "no-referrer" });
    applySecurityHeaders(override, "/");
    expect(override.get("referrer-policy")).toBe("no-referrer");
  });
});
