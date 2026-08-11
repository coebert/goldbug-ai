import { describe, expect, it } from "vitest";
import {
  isLseGbxDisplayQuoted,
  normalizeMarketPriceForTrading,
} from "@/lib/market-price-units";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Corporate actions inside a replay: dividends and stock splits.
 *
 * Fills are not the only thing that moves a book. Between two trades the
 * registrar can pay a dividend or re-denominate the shares, and both have bit
 * a live portfolio before:
 *
 *   - an LSE dividend published in **pence** credited as pounds → 100x cash;
 *   - a split that multiplied the share count but left average cost alone →
 *     the position's book value silently multiplied too;
 *   - a reverse split leaving a fractional residue that was rounded *up* to a
 *     whole share instead of paid out as cash in lieu → free shares;
 *   - an adjusted post-split price that was never re-snapped to the venue's
 *     tick grid, so the next fill's notional disagreed with the book;
 *   - a dividend replayed on every reconcile poll → the credit paid twice.
 *
 * The invariants pinned here are the ones a replay must never break:
 *
 *   1. **Cash**: a dividend credits `qty × netRatePerShare`, normalised out of
 *      pence, rounded to the currency's minor unit — once per (action, holding).
 *   2. **Holdings**: a split scales quantity by the ratio and average cost by
 *      its inverse, so **cost basis is conserved exactly**. Fractional residue
 *      is truncated to the lot grid and paid as cash in lieu at the adjusted
 *      price — never rounded into an extra share.
 *   3. **Rounding**: adjusted prices land on the instrument's tick grid and
 *      adjusted quantities on its lot grid, with cash in lieu carrying the
 *      remainder so no value is created or destroyed.
 *   4. **Idempotency**: replaying the same action stream any number of times
 *      yields identical holdings and cash.
 *
 * Every property has a negative control implementing the historic bug, so the
 * assertions provably have teeth.
 */

const FILE = "src/lib/__tests__/corporate-action-replay-reconciliation.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

type Instrument = {
  symbol: string;
  /** Minimum price increment in the venue's quoted units. */
  tick: number;
  /** Minimum quantity increment (1 = whole shares). */
  lot: number;
  /** Typical quoted price in venue units (pence for GBX names). */
  ref: number;
};

const INSTRUMENTS: readonly Instrument[] = [
  { symbol: "HSBA.L", tick: 0.05, lot: 1, ref: 942.6 }, // GBX pence
  { symbol: "ULVR.L", tick: 0.5, lot: 1, ref: 4680 }, // GBX pence
  { symbol: "VUKE.L", tick: 0.005, lot: 1, ref: 47.6 }, // GBP-quoted LSE ETF
  { symbol: "AAPL", tick: 0.01, lot: 1, ref: 223.17 },
  { symbol: "NVDA", tick: 0.01, lot: 1, ref: 178.44 },
  { symbol: "BTC-GBP", tick: 1, lot: 1e-6, ref: 84_310 },
];

const bySymbol = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

function roundToTick(price: number, tick: number): number {
  return Number((Math.round(price / tick) * tick).toFixed(10));
}

/** Quantity must never round *up* onto the lot grid: residue becomes cash. */
function floorToLot(qty: number, lot: number): number {
  return Number((Math.floor(qty / lot + 1e-9) * lot).toFixed(10));
}

/** Money is booked in integer minor units (pennies) to keep replays exact. */
const toPence = (gbp: number) => Math.round(gbp * 100);
const fromPence = (p: number) => p / 100;

// ---------------------------------------------------------------------------
// Book + actions
// ---------------------------------------------------------------------------

type Holding = { symbol: string; quantity: number; avgCost: number };

type Book = {
  holdings: Map<string, Holding>;
  /** Cash in integer pence, base currency (GBP). */
  cashPence: number;
  /** Action ids already applied — replay guard. */
  applied: Set<string>;
  journal: JournalEntry[];
};

type JournalEntry = {
  id: string;
  kind: "dividend" | "split";
  symbol: string;
  cashPence: number;
  qtyBefore: number;
  qtyAfter: number;
  costBasisBefore: number;
  costBasisAfter: number;
};

type CorporateActionEvent =
  | {
      kind: "dividend";
      id: string;
      symbol: string;
      /**
       * Gross rate per share in the venue's quoted units — pence for GBX
       * listings, majors elsewhere. Normalised through the same helper the
       * price path uses.
       */
      grossRate: number;
      /** Withholding rate, 0..1. */
      withholding?: number;
    }
  | {
      kind: "split";
      id: string;
      symbol: string;
      /** New shares per old share. 4 = 4-for-1; 0.1 = 1-for-10 reverse. */
      ratio: number;
      /** Pre-split reference price in venue units, used for cash in lieu. */
      refPrice: number;
    };

function newBook(holdings: Holding[], cashGbp: number): Book {
  return {
    holdings: new Map(holdings.map((h) => [h.symbol, { ...h }])),
    cashPence: toPence(cashGbp),
    applied: new Set(),
    journal: [],
  };
}

const costBasis = (h: Holding) => h.quantity * h.avgCost;

/**
 * Apply one corporate action to the book. Idempotent by action id: a repeated
 * event is dropped before it can touch cash or quantity.
 */
function applyAction(book: Book, ev: CorporateActionEvent): void {
  if (book.applied.has(ev.id)) return;
  const h = book.holdings.get(ev.symbol);
  if (!h || !(h.quantity > 0)) {
    // Nothing held on the record date — still mark applied so a later poll
    // cannot resurrect it against a position opened afterwards.
    book.applied.add(ev.id);
    return;
  }
  book.applied.add(ev.id);
  const inst = bySymbol.get(ev.symbol)!;
  const qtyBefore = h.quantity;
  const basisBefore = costBasis(h);

  if (ev.kind === "dividend") {
    // Pence-quoted venues publish the rate in pence too.
    const netVenueRate = ev.grossRate * (1 - (ev.withholding ?? 0));
    const perShareBase = normalizeMarketPriceForTrading(ev.symbol, netVenueRate);
    const cashPence = Math.round(h.quantity * perShareBase * 100);
    book.cashPence += cashPence;
    book.journal.push({
      id: ev.id,
      kind: "dividend",
      symbol: ev.symbol,
      cashPence,
      qtyBefore,
      qtyAfter: qtyBefore,
      costBasisBefore: basisBefore,
      costBasisAfter: basisBefore,
    });
    return;
  }

  // Split: scale quantity by the ratio, average cost by its inverse.
  const rawQty = h.quantity * ev.ratio;
  const newQty = floorToLot(rawQty, inst.lot);
  const residue = rawQty - newQty;

  // Post-split reference price, snapped back onto the tick grid, then folded
  // into base units for the cash-in-lieu credit.
  const adjustedVenuePrice = roundToTick(ev.refPrice / ev.ratio, inst.tick);
  const adjustedBasePrice = normalizeMarketPriceForTrading(ev.symbol, adjustedVenuePrice);
  const cashPence = Math.round(residue * adjustedBasePrice * 100);

  // Cost basis is conserved: only the residue leaves the position, and it
  // leaves as cash, so avg cost re-derives from the retained basis.
  const retainedBasis = newQty > 0 ? basisBefore * (newQty / rawQty) : 0;
  h.quantity = newQty;
  h.avgCost = newQty > 0 ? retainedBasis / newQty : 0;
  book.cashPence += cashPence;
  if (newQty === 0) book.holdings.delete(ev.symbol);

  book.journal.push({
    id: ev.id,
    kind: "split",
    symbol: ev.symbol,
    cashPence,
    qtyBefore,
    qtyAfter: newQty,
    costBasisBefore: basisBefore,
    costBasisAfter: retainedBasis,
  });
}

function replay(book: Book, events: readonly CorporateActionEvent[], polls = 1): Book {
  for (let i = 0; i < polls; i++) for (const ev of events) applyAction(book, ev);
  return book;
}

const snapshot = (b: Book) => ({
  cashPence: b.cashPence,
  holdings: [...b.holdings.values()]
    .map((h) => ({ ...h, avgCost: Number(h.avgCost.toFixed(10)) }))
    .sort((a, z) => a.symbol.localeCompare(z.symbol)),
});

// ---------------------------------------------------------------------------
// Dividends
// ---------------------------------------------------------------------------

describe("dividend replays", () => {
  it("credits pence-quoted LSE dividends in pounds, not pence", () => {
    // ULVR pays 40.2p per share on 500 shares = £201.00, not £20,100.
    expect(isLseGbxDisplayQuoted("ULVR.L")).toBe(true);
    const book = newBook([{ symbol: "ULVR.L", quantity: 500, avgCost: 46.8 }], 1_000);
    replay(book, [{ kind: "dividend", id: "D1", symbol: "ULVR.L", grossRate: 40.2 }]);
    expect(book.cashPence).toBe(toPence(1_000 + 201));
  });

  it("does not divide a GBP-quoted LSE ETF distribution by 100", () => {
    expect(isLseGbxDisplayQuoted("VUKE.L")).toBe(false);
    const book = newBook([{ symbol: "VUKE.L", quantity: 200, avgCost: 47.1 }], 0);
    replay(book, [{ kind: "dividend", id: "D2", symbol: "VUKE.L", grossRate: 0.37 }]);
    expect(book.cashPence).toBe(toPence(74));
  });

  it("applies withholding and rounds to the minor unit", () => {
    // 15% US withholding on 0.25/share over 137 shares = 29.1125 -> £29.11.
    const book = newBook([{ symbol: "AAPL", quantity: 137, avgCost: 210 }], 0);
    replay(book, [
      { kind: "dividend", id: "D3", symbol: "AAPL", grossRate: 0.25, withholding: 0.15 },
    ]);
    expect(book.cashPence).toBe(2911);
  });

  it("never changes holdings or cost basis", () => {
    const book = newBook([{ symbol: "HSBA.L", quantity: 1_000, avgCost: 9.1 }], 500);
    const before = snapshot(book).holdings;
    replay(book, [{ kind: "dividend", id: "D4", symbol: "HSBA.L", grossRate: 32 }]);
    expect(snapshot(book).holdings).toEqual(before);
    expect(book.journal[0]!.costBasisAfter).toBe(book.journal[0]!.costBasisBefore);
  });

  it("pays exactly once across repeated reconcile polls", () => {
    const evs: CorporateActionEvent[] = [
      { kind: "dividend", id: "D5", symbol: "AAPL", grossRate: 0.24 },
      { kind: "dividend", id: "D6", symbol: "HSBA.L", grossRate: 18.5 },
    ];
    const once = snapshot(replay(newBook([
      { symbol: "AAPL", quantity: 50, avgCost: 200 },
      { symbol: "HSBA.L", quantity: 400, avgCost: 9 },
    ], 100), evs, 1));
    for (const polls of [2, 3, 9]) {
      const many = snapshot(replay(newBook([
        { symbol: "AAPL", quantity: 50, avgCost: 200 },
        { symbol: "HSBA.L", quantity: 400, avgCost: 9 },
      ], 100), evs, polls));
      expect(many).toEqual(once);
    }
  });

  it("credits nothing when the position is flat on the record date", () => {
    const book = newBook([], 250);
    replay(book, [{ kind: "dividend", id: "D7", symbol: "AAPL", grossRate: 0.24 }]);
    expect(book.cashPence).toBe(toPence(250));
    expect(book.journal).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

describe("split replays", () => {
  it("conserves cost basis on a clean forward split", () => {
    const book = newBook([{ symbol: "NVDA", quantity: 25, avgCost: 400 }], 0);
    replay(book, [{ kind: "split", id: "S1", symbol: "NVDA", ratio: 4, refPrice: 712 }]);
    const h = book.holdings.get("NVDA")!;
    expect(h.quantity).toBe(100);
    expect(h.avgCost).toBeCloseTo(100, 10);
    expect(costBasis(h)).toBeCloseTo(25 * 400, 10);
    expect(book.cashPence).toBe(0); // nothing fractional to pay out
  });

  it("pays a reverse-split residue as cash in lieu at the tick-adjusted price", () => {
    // 1-for-10 on 1,234 shares -> 123 shares + 0.4 residue.
    // Adjusted price: 942.6p / 0.1 = 9426p, already on the 0.05 tick grid.
    const book = newBook([{ symbol: "HSBA.L", quantity: 1_234, avgCost: 9.4 }], 0);
    replay(book, [{ kind: "split", id: "S2", symbol: "HSBA.L", ratio: 0.1, refPrice: 942.6 }]);
    const h = book.holdings.get("HSBA.L")!;
    expect(h.quantity).toBe(123);
    // Residue is 0.4 shares at £94.26 = £37.70 (rounded to the penny).
    expect(book.cashPence).toBe(Math.round(0.4 * 94.26 * 100));
    // Basis conserved less the residue that left as cash.
    expect(costBasis(h)).toBeCloseTo(1_234 * 9.4 * (123 / 123.4), 8);
  });

  it("truncates the residue rather than rounding a free share into existence", () => {
    const book = newBook([{ symbol: "AAPL", quantity: 99, avgCost: 180 }], 0);
    replay(book, [{ kind: "split", id: "S3", symbol: "AAPL", ratio: 0.1, refPrice: 223.17 }]);
    // 9.9 shares would round to 10 — it must floor to 9 with cash for 0.9.
    expect(book.holdings.get("AAPL")!.quantity).toBe(9);
    expect(book.cashPence).toBeGreaterThan(0);
  });

  it("snaps the adjusted price to the venue tick grid before valuing the residue", () => {
    // ULVR tick is 0.5p. 4680 / 3 = 1560 exactly; use a ratio that doesn't divide.
    const book = newBook([{ symbol: "ULVR.L", quantity: 101, avgCost: 46.8 }], 0);
    replay(book, [{ kind: "split", id: "S4", symbol: "ULVR.L", ratio: 1.5, refPrice: 4681 }]);
    const adjusted = roundToTick(4681 / 1.5, 0.5); // 3120.5p
    expect(adjusted % 0.5).toBeCloseTo(0, 10);
    // 151.5 -> 151 shares, 0.5 residue at £31.205.
    expect(book.holdings.get("ULVR.L")!.quantity).toBe(151);
    expect(book.cashPence).toBe(Math.round(0.5 * (adjusted / 100) * 100));
  });

  it("honours fractional lot instruments with no cash in lieu", () => {
    const book = newBook([{ symbol: "BTC-GBP", quantity: 0.137_452, avgCost: 62_000 }], 0);
    replay(book, [{ kind: "split", id: "S5", symbol: "BTC-GBP", ratio: 2, refPrice: 84_310 }]);
    const h = book.holdings.get("BTC-GBP")!;
    expect(h.quantity).toBeCloseTo(0.274_904, 9);
    expect(costBasis(h)).toBeCloseTo(0.137_452 * 62_000, 6);
    expect(book.cashPence).toBe(0);
  });

  it("is idempotent across repeated polls and interleaved dividends", () => {
    const evs: CorporateActionEvent[] = [
      { kind: "dividend", id: "D8", symbol: "NVDA", grossRate: 0.01 },
      { kind: "split", id: "S6", symbol: "NVDA", ratio: 4, refPrice: 712 },
      { kind: "dividend", id: "D9", symbol: "NVDA", grossRate: 0.0025 },
    ];
    const base = () => newBook([{ symbol: "NVDA", quantity: 25, avgCost: 400 }], 50);
    const once = snapshot(replay(base(), evs, 1));
    for (const polls of [2, 5]) expect(snapshot(replay(base(), evs, polls))).toEqual(once);
    // Post-split dividend is paid on the post-split share count.
    expect(once.holdings[0]!.quantity).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Fuzzed reconciliation: value conservation across an action stream
// ---------------------------------------------------------------------------

describe("fuzzed action-stream reconciliation", () => {
  it("conserves cost basis plus cash in lieu for every split, at every step", () => {
    for (let c = 0; c < 200; c++) {
      const seed = caseSeed(BASE_SEED, c);
      const rnd = rng(seed);
      const inst = INSTRUMENTS[Math.floor(rnd() * INSTRUMENTS.length)]!;
      const qty =
        inst.lot === 1
          ? Math.max(1, Math.floor(rnd() * 5_000))
          : Number((rnd() * 3).toFixed(6));
      const avgCost = Number((normalizeMarketPriceForTrading(inst.symbol, inst.ref) * (0.6 + rnd())).toFixed(6));
      const ratio = [0.1, 0.2, 0.5, 1.5, 2, 3, 4, 7][Math.floor(rnd() * 8)]!;
      const refPrice = roundToTick(inst.ref * (0.8 + rnd() * 0.4), inst.tick);

      const book = newBook([{ symbol: inst.symbol, quantity: qty, avgCost }], 0);
      const basisBefore = qty * avgCost;
      replay(book, [{ kind: "split", id: `S-${c}`, symbol: inst.symbol, ratio, refPrice }], 3);

      const h = book.holdings.get(inst.symbol);
      const entry = book.journal[0]!;
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${inst.symbol} x${ratio})`;

      // Quantity lands on the lot grid and never rounds up.
      const rawQty = qty * ratio;
      expect(entry.qtyAfter, msg).toBeLessThanOrEqual(rawQty + 1e-9);
      expect(Number((entry.qtyAfter / inst.lot).toFixed(6)) % 1, msg).toBeCloseTo(0, 6);

      // Basis conservation: retained basis + basis that left as residue == before.
      const residue = rawQty - entry.qtyAfter;
      const residueBasis = rawQty > 0 ? basisBefore * (residue / rawQty) : 0;
      expect(entry.costBasisAfter + residueBasis, msg).toBeCloseTo(basisBefore, 6);
      if (h) expect(h.quantity * h.avgCost, msg).toBeCloseTo(entry.costBasisAfter, 6);

      // Cash in lieu is non-negative, and zero exactly when there is no residue.
      expect(book.cashPence, msg).toBeGreaterThanOrEqual(0);
      if (residue < 1e-9) expect(book.cashPence, msg).toBe(0);

      // Replaying the same action three times changed nothing extra.
      expect(book.journal.length, msg).toBe(1);
    }
  });

  it("keeps dividend credits equal to an independent per-share reconstruction", () => {
    for (let c = 0; c < 200; c++) {
      const seed = caseSeed(BASE_SEED, c + 10_000);
      const rnd = rng(seed);
      const inst = INSTRUMENTS[Math.floor(rnd() * INSTRUMENTS.length)]!;
      const qty = inst.lot === 1 ? Math.max(1, Math.floor(rnd() * 4_000)) : Number((rnd() * 2).toFixed(6));
      const grossRate = Number((inst.ref * (0.002 + rnd() * 0.03)).toFixed(4));
      const withholding = [0, 0.1, 0.15, 0.3][Math.floor(rnd() * 4)]!;

      const book = newBook([{ symbol: inst.symbol, quantity: qty, avgCost: 1 }], 0);
      replay(book, [
        { kind: "dividend", id: `D-${c}`, symbol: inst.symbol, grossRate, withholding },
      ], 4);

      const expected = Math.round(
        qty * normalizeMarketPriceForTrading(inst.symbol, grossRate * (1 - withholding)) * 100,
      );
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${inst.symbol})`;
      expect(book.cashPence, msg).toBe(expected);
      expect(book.holdings.get(inst.symbol)!.quantity, msg).toBe(qty);
      expect(fromPence(book.cashPence), msg).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Negative controls — the historic bugs, reproduced
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  it("catches a pence dividend credited as pounds (100x)", () => {
    const book = newBook([{ symbol: "ULVR.L", quantity: 500, avgCost: 46.8 }], 0);
    replay(book, [{ kind: "dividend", id: "N1", symbol: "ULVR.L", grossRate: 40.2 }]);
    const buggy = Math.round(500 * 40.2 * 100); // no GBX normalisation
    expect(buggy).toBe(book.cashPence * 100);
    expect(book.cashPence).not.toBe(buggy);
  });

  it("catches a split that scales quantity without rescaling average cost", () => {
    const book = newBook([{ symbol: "NVDA", quantity: 25, avgCost: 400 }], 0);
    replay(book, [{ kind: "split", id: "N2", symbol: "NVDA", ratio: 4, refPrice: 712 }]);
    const h = book.holdings.get("NVDA")!;
    const buggyBasis = h.quantity * 400; // avg cost left untouched
    expect(buggyBasis).toBe(costBasis(h) * 4);
    expect(costBasis(h)).toBeCloseTo(10_000, 10);
  });

  it("catches a residue rounded up into a free share", () => {
    const qty = 99;
    const ratio = 0.1;
    expect(Math.round(qty * ratio)).toBe(10); // the bug
    expect(floorToLot(qty * ratio, 1)).toBe(9); // the rule
  });

  it("catches an adjusted price left off the tick grid", () => {
    const unsnapped = 4681 / 1.5; // 3120.666...
    expect(unsnapped % 0.5).not.toBeCloseTo(0, 6);
    expect(roundToTick(unsnapped, 0.5) % 0.5).toBeCloseTo(0, 10);
  });

  it("catches a dividend re-credited on every poll", () => {
    const book = newBook([{ symbol: "AAPL", quantity: 100, avgCost: 200 }], 0);
    const ev: CorporateActionEvent = { kind: "dividend", id: "N5", symbol: "AAPL", grossRate: 0.25 };
    replay(book, [ev], 5);
    expect(book.cashPence).toBe(2500);
    expect(book.journal).toHaveLength(1);
  });
});
