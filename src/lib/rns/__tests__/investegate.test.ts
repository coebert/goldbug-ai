import { describe, expect, it } from "vitest";
import {
  classifyNature,
  isPdmrTitle,
  normaliseRole,
  parsePdmrNotifications,
  parsePriceVolume,
  parseRnsDate,
  parseRnsListing,
  pdmrToEvent,
} from "../investegate";

const LISTING = `
<table><tbody>
<tr><td>03 Aug 2026</td><td>09:00 AM</td><td><a href="https://www.investegate.co.uk/source/RNS">RNS</a></td>
<td><a class="announcement-link" href="https://www.investegate.co.uk/announcement/rns/mks/total-voting-rights/1">Total Voting Rights</a></td></tr>
<tr><td>28 Jul 2026</td><td>11:52 AM</td><td>RNS</td>
<td><a class="announcement-link" href="https://www.investegate.co.uk/announcement/rns/mks/director-pdmr-shareholding/2">Director/PDMR Shareholding</a></td></tr>
</tbody></table>`;

const BODY = `
Marks and Spencer Group PLC 22 July 2026 Director/PDMR Shareholding
1 Details of the person discharging managerial responsibilities/person closely associated
a) Name S Berendji
2 Reason for the notification a) Position/status PDMR (Operations Director) b) Initial notification/Amendment Initial notification
3 Details of the issuer a) Name Marks and Spencer Group plc
4 Details of the transaction(s):
a) Description of the financial instrument Ordinary 1p shares ISIN: GB0031274896
b) Nature of the transaction Sale of ordinary shares
c) Price(s) and volume(s) Price(s) Volume(s) &#163;3.976 300,000
d) Aggregated information - Price n/a (single transaction)
e) Date of the transaction 2026-07-22
f) Place of the transaction London Stock Exchange (XLON)
1 Details of the person discharging managerial responsibilities/person closely associated
a) Name A Freudmann
2 Reason for the notification a) Position/status PDMR (Managing Director, Food) b) Initial notification/Amendment Initial notification
4 Details of the transaction(s):
b) Nature of the transaction Acquisition of Partnership Shares through the Company's Share Incentive Plan
c) Price(s) and volume(s) Price(s) Volume(s) &#163;3.881 39
e) Date of the transaction 2026-07-27
`;

describe("parseRnsDate", () => {
  it("reads wire and ISO formats", () => {
    expect(parseRnsDate("28 Jul 2026")).toBe("2026-07-28");
    expect(parseRnsDate("3 September 2026")).toBe("2026-09-03");
    expect(parseRnsDate("2026-07-22")).toBe("2026-07-22");
    expect(parseRnsDate("not a date")).toBeNull();
  });
});

describe("parseRnsListing", () => {
  it("extracts dated announcement rows, newest first", () => {
    const items = parseRnsListing(LISTING);
    expect(items).toHaveLength(2);
    expect(items[0]?.date).toBe("2026-08-03");
    expect(items[1]?.title).toBe("Director/PDMR Shareholding");
  });

  it("keeps only director-dealing titles", () => {
    const pdmr = parseRnsListing(LISTING).filter((i) => isPdmrTitle(i.title));
    expect(pdmr.map((i) => i.title)).toEqual(["Director/PDMR Shareholding"]);
  });
});

describe("classifyNature", () => {
  it("separates discretionary sales from mechanical plan purchases", () => {
    expect(classifyNature("Sale of ordinary shares")).toEqual({ direction: "sell", flavour: "discretionary" });
    expect(classifyNature("Acquisition of Partnership Shares through the Share Incentive Plan")).toEqual({
      direction: "buy",
      flavour: "award",
    });
    expect(classifyNature("Sale of shares to cover tax liability on vesting")).toEqual({
      direction: "sell",
      flavour: "tax",
    });
    expect(classifyNature(null)).toEqual({ direction: "unknown", flavour: "unknown" });
  });
});

describe("parsePriceVolume", () => {
  it("aggregates pairs and normalises pence to pounds", () => {
    expect(parsePriceVolume(" £3.976 300,000 ")).toEqual({ price: 3.976, volume: 300000, currency: "GBP" });
    const pence = parsePriceVolume(" 397.6p 100 ");
    expect(pence.price).toBeCloseTo(3.976, 6);
    expect(pence.currency).toBe("GBX");
    expect(parsePriceVolume("no numbers here")).toEqual({ price: null, volume: null, currency: null });
  });
});

describe("parsePdmrNotifications", () => {
  const notes = parsePdmrNotifications(BODY, "2026-07-22");

  it("splits one block per PDMR", () => {
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.person)).toEqual(["S Berendji", "A Freudmann"]);
  });

  it("reads position, nature, price, volume and transaction date", () => {
    const first = notes[0]!;
    expect(first.position).toContain("Operations Director");
    expect(first.nature).toBe("Sale of ordinary shares");
    expect(first.price).toBeCloseTo(3.976, 3);
    expect(first.volume).toBe(300000);
    expect(first.value).toBeCloseTo(1192800, 0);
    expect(first.date).toBe("2026-07-22");
  });

  it("falls back to the announcement date when 4(e) is missing", () => {
    expect(parsePdmrNotifications(BODY.replace(/e\) Date of the transaction[^\n]*/g, ""), "2026-07-22")[0]?.date).toBe(
      "2026-07-22",
    );
  });
});

describe("normaliseRole", () => {
  it("maps RNS positions onto engine roles", () => {
    expect(normaliseRole("Chief Executive Officer")).toBe("CEO");
    expect(normaliseRole("PDMR (Managing Director, Food)")).toBe("MD");
    expect(normaliseRole("Group Finance Director")).toBe("CFO");
    expect(normaliseRole("Some other job")).toBe("PDMR");
    expect(normaliseRole(null)).toBeNull();
  });
});

describe("pdmrToEvent", () => {
  const ctx = { symbol: "MKS.L", company: "Marks & Spencer", url: "https://x/1", announcedAt: "2026-07-22" };
  const notes = parsePdmrNotifications(BODY, "2026-07-22");

  it("scores a large discretionary sale negatively", () => {
    const e = pdmrToEvent(notes[0]!, ctx);
    expect(e.direction).toBe("sell");
    expect(e.flavour).toBe("discretionary");
    expect(e.sentiment_nudge).toBeLessThan(0);
    expect(e.sentiment_nudge).toBeGreaterThanOrEqual(-0.15);
    expect(e.source).toBe("RNS (Investegate)");
    expect(e.headline).toContain("S Berendji");
  });

  it("treats a tiny Share Incentive Plan purchase as near-noise", () => {
    const e = pdmrToEvent(notes[1]!, ctx);
    expect(e.direction).toBe("buy");
    expect(e.flavour).toBe("award");
    expect(Math.abs(e.sentiment_nudge)).toBeLessThan(0.03);
  });
});
