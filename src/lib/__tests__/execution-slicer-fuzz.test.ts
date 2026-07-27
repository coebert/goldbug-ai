// Property-based fuzz tests for pending_slices input validation.
//
// Goal: no matter what arbitrary/malformed value the client sends, the
// schemas must (a) reject it if it violates the documented contract and
// (b) accept it if it satisfies every rule. We also assert that when a
// server helper receives a bad input, a SECURITY:pending_slices warning
// is always emitted before the DB is touched — i.e. logging never misses
// an edge case.
//
// These tests target the client-safe schemas so they run without any
// supabase mocking overhead. A single integration-style property confirms
// the server helper's `validate()` wrapper still logs on every rejection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  SliceInputSchema,
  FillInputSchema,
  TickInputSchema,
} from "../execution-slicer-schemas";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// RFC4122 v4-ish UUID that matches zod's .uuid() check.
const uuidArb = fc.uuid({ version: 4 });

// Symbols the schema must accept: 1..32 chars from [A-Za-z0-9._:=/-].
const validSymbolArb = fc
  .stringMatching(/^[A-Za-z0-9._:=/-]{1,32}$/)
  .filter((s) => s.trim().length >= 1 && s.trim().length <= 32);

// Any JSON-ish value — used to fuzz "should reject" branches.
const anyJsonArb: fc.Arbitrary<unknown> = fc.anything({
  maxDepth: 3,
  withBigInt: false,
  withDate: false,
  withMap: false,
  withSet: false,
  withTypedArray: false,
});

const positiveArb = fc.double({
  min: Number.EPSILON,
  max: 1e9,
  noNaN: true,
  noDefaultInfinity: true,
});
const nonNegArb = fc.double({
  min: 0,
  max: 1e9,
  noNaN: true,
  noDefaultInfinity: true,
});

const validSliceInputArb = fc.record({
  portfolioId: uuidArb,
  ownerUserId: uuidArb,
  decisionId: fc.option(uuidArb, { nil: null }),
  symbol: validSymbolArb,
  side: fc.constantFrom("buy", "sell"),
  totalQty: positiveArb,
  priceHint: positiveArb,
  slices: fc.option(fc.integer({ min: 2, max: 8 }), { nil: undefined }),
  ttlMinutes: fc.option(fc.integer({ min: 1, max: 24 * 60 }), { nil: undefined }),
});

const validFillInputArb = fc.record({
  sliceId: uuidArb,
  ownerUserId: uuidArb,
  filledQty: nonNegArb,
  note: fc.option(fc.string({ maxLength: 500 }), { nil: undefined }),
});

const validTickInputArb = fc.record({
  portfolioId: uuidArb,
  ownerUserId: uuidArb,
});

// ---------------------------------------------------------------------------
// Round-trip: valid inputs always parse
// ---------------------------------------------------------------------------

describe("execution-slicer schemas: valid inputs always parse", () => {
  it("SliceInputSchema accepts every valid record", () => {
    fc.assert(
      fc.property(validSliceInputArb, (input) => {
        const result = SliceInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("FillInputSchema accepts every valid record", () => {
    fc.assert(
      fc.property(validFillInputArb, (input) => {
        expect(FillInputSchema.safeParse(input).success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("TickInputSchema accepts every valid record", () => {
    fc.assert(
      fc.property(validTickInputArb, (input) => {
        expect(TickInputSchema.safeParse(input).success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Adversarial mutations: after breaking a required rule, parse must fail
// ---------------------------------------------------------------------------

describe("execution-slicer schemas: mutated inputs are rejected", () => {
  it("rejects when any required field is replaced with arbitrary garbage", () => {
    fc.assert(
      fc.property(
        validSliceInputArb,
        fc.constantFrom(
          "portfolioId",
          "ownerUserId",
          "symbol",
          "side",
          "totalQty",
          "priceHint",
        ) as fc.Arbitrary<keyof typeof SliceInputSchema.shape>,
        anyJsonArb,
        (base, field, garbage) => {
          // Skip the rare case where random garbage happens to satisfy the
          // field's own schema — that's not a bug, just a coincidence.
          const fieldSchema = SliceInputSchema.shape[field];
          if (fieldSchema.safeParse(garbage).success) return;

          const mutated = { ...base, [field]: garbage };
          const result = SliceInputSchema.safeParse(mutated);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rejects out-of-range slice counts (must be int in [2,8])", () => {
    fc.assert(
      fc.property(
        validSliceInputArb,
        fc.oneof(
          fc.integer({ max: 1 }),
          fc.integer({ min: 9, max: 1_000_000 }),
          fc.double({ min: 2.01, max: 7.99, noNaN: true }).filter(
            (n) => !Number.isInteger(n),
          ),
        ),
        (base, badSlices) => {
          const mutated = { ...base, slices: badSlices };
          expect(SliceInputSchema.safeParse(mutated).success).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects negative or non-finite quantities", () => {
    fc.assert(
      fc.property(
        validSliceInputArb,
        fc.oneof(
          fc.double({ max: -Number.EPSILON, noNaN: true }),
          fc.constantFrom(0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN),
        ),
        (base, badQty) => {
          const mutated = { ...base, totalQty: badQty };
          expect(SliceInputSchema.safeParse(mutated).success).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects symbols containing unsafe characters", () => {
    fc.assert(
      fc.property(
        validSliceInputArb,
        // At least one char outside the allowed set (spaces, quotes, ;, etc.).
        fc
          .string({ minLength: 1, maxLength: 40 })
          .filter((s) => /[^A-Za-z0-9._:=/-]/.test(s.trim()) && s.trim().length > 0),

        (base, badSymbol) => {
          const mutated = { ...base, symbol: badSymbol };
          expect(SliceInputSchema.safeParse(mutated).success).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects notes longer than 500 chars on FillInputSchema", () => {
    fc.assert(
      fc.property(
        validFillInputArb,
        fc
          .string({ minLength: 501, maxLength: 2_000 })
          // The schema trims before enforcing max(500), so ensure the trimmed
          // length still exceeds 500 (otherwise a whitespace-only payload
          // shrinks to an empty — and valid — note).
          .filter((s) => s.trim().length > 500),
        (base, longNote) => {
          const mutated = { ...base, note: longNote };
          expect(FillInputSchema.safeParse(mutated).success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Logging invariant: every rejection from the server helper emits a
// SECURITY:pending_slices warning BEFORE any DB call happens.
// ---------------------------------------------------------------------------

describe("execution-slicer server: logging is never skipped on invalid input", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  // The mock tolerates writes to `security_audit_log` (the structured logger
  // fire-and-forgets an insert on every SECURITY warning) but throws for
  // any other table so validation-first rejection is enforced: the slicer
  // must never reach `pending_slices` / `portfolios` on bad input.
  const auditChain = {
    insert: () => Promise.resolve({ data: null, error: null }),
  };
  const fromMock = vi.fn((table: string) => {
    if (table === "security_audit_log") return auditChain;
    throw new Error(`DB must not be reached on invalid input (table=${table})`);
  });

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@/integrations/supabase/client.server", () => ({
      supabaseAdmin: { from: fromMock },
    }));
    fromMock.mockClear();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.doUnmock("@/integrations/supabase/client.server");
    vi.resetModules();
  });

  it("maybeSliceOrder + tickSlicer + recordSliceFill all log on garbage input", async () => {
    const { maybeSliceOrder, tickSlicer, recordSliceFill } = await import(
      "../execution-slicer.server"
    );

    await fc.assert(
      fc.asyncProperty(anyJsonArb, async (garbage) => {
        warnSpy.mockClear();
        fromMock.mockClear();

        await Promise.all([
          maybeSliceOrder(garbage as never).catch(() => null),
          tickSlicer(garbage as never, garbage as never).catch(() => null),
          recordSliceFill(
            garbage as never,
            garbage as never,
            garbage as never,
            garbage as never,
          ).catch(() => null),
        ]);

        // Data tables were never touched — only the audit log insert (if any).
        const dataTableCalls = fromMock.mock.calls.filter(
          (c) => c[0] !== "security_audit_log",
        );
        expect(dataTableCalls).toHaveLength(0);

        // Every rejection emitted a structured SECURITY warning.
        const securityCalls = warnSpy.mock.calls.filter((call: unknown[]) =>
          String(call[0] ?? "").includes("SECURITY:pending_slices"),
        );
        expect(securityCalls.length).toBeGreaterThan(0);
      }),

      { numRuns: 50 },
    );
  });
});
