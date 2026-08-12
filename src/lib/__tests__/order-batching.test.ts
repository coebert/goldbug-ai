import { describe, expect, it } from "vitest";
import { planBatchWindow } from "../order-batching";

const now = new Date("2026-08-12T10:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

const buy = (symbol: string, quantity: number, price: number, notionalBase: number) => ({
  symbol,
  side: "buy" as const,
  quantity,
  price,
  notionalBase,
});

describe("order batching window", () => {
  it("parks a sub-minimum buy instead of trading it", () => {
    const plan = planBatchWindow({
      incoming: [buy("VUSA.L", 10, 9, 90)],
      parked: [],
      minTicketBase: 250,
      now,
    });
    expect(plan.release).toHaveLength(0);
    expect(plan.park[0]).toMatchObject({ symbol: "VUSA.L", quantity: 10, shortfallBase: 160 });
  });

  it("releases one combined ticket once parked plus new clears the minimum", () => {
    const plan = planBatchWindow({
      incoming: [buy("VUSA.L", 12, 9, 108)],
      parked: [
        {
          id: "p1",
          symbol: "VUSA.L",
          quantity: 20,
          price: 9,
          notionalBase: 180,
          firstSeenAt: hoursAgo(6),
        },
      ],
      minTicketBase: 250,
      now,
    });
    expect(plan.park).toHaveLength(0);
    expect(plan.release).toHaveLength(1);
    expect(plan.release[0]!.order.quantity).toBe(32);
    expect(plan.release[0]!.notionalBase).toBeCloseTo(288, 6);
    expect(plan.consumedIds).toEqual(["p1"]);
  });

  it("accumulates across ticks rather than paying the floor each time", () => {
    let parked = planBatchWindow({
      incoming: [buy("MKS.L", 10, 9, 90)],
      parked: [],
      minTicketBase: 250,
      now,
    }).park.map((p) => ({ ...p, id: "p1" }));
    const second = planBatchWindow({
      incoming: [buy("MKS.L", 10, 9, 90)],
      parked,
      minTicketBase: 250,
      now,
    });
    expect(second.release).toHaveLength(0);
    expect(second.park[0]!.quantity).toBe(20);
    parked = second.park.map((p) => ({ ...p, id: "p1" }));
    const third = planBatchWindow({
      incoming: [buy("MKS.L", 10, 9, 90)],
      parked,
      minTicketBase: 250,
      now,
    });
    expect(third.release).toHaveLength(1);
    expect(third.release[0]!.order.quantity).toBe(30);
  });

  it("routes a full-size buy immediately, absorbing parked quantity", () => {
    const plan = planBatchWindow({
      incoming: [buy("VUSA.L", 40, 9, 360)],
      parked: [
        { id: "p1", symbol: "VUSA.L", quantity: 10, price: 9, notionalBase: 90, firstSeenAt: hoursAgo(2) },
      ],
      minTicketBase: 250,
      now,
    });
    expect(plan.release[0]!.order.quantity).toBe(50);
    expect(plan.release[0]!.parkedQuantity).toBe(10);
  });

  it("never batches sells", () => {
    const plan = planBatchWindow({
      incoming: [{ symbol: "MKS.L", side: "sell", quantity: 5, price: 9, notionalBase: 45 }],
      parked: [],
      minTicketBase: 250,
      now,
    });
    expect(plan.release).toHaveLength(1);
    expect(plan.park).toHaveLength(0);
  });

  it("cancels a parked add when an exit arrives in the same name", () => {
    const plan = planBatchWindow({
      incoming: [{ symbol: "MKS.L", side: "sell", quantity: 5, price: 9, notionalBase: 45 }],
      parked: [
        { id: "p1", symbol: "MKS.L", quantity: 10, price: 9, notionalBase: 90, firstSeenAt: hoursAgo(1) },
      ],
      minTicketBase: 250,
      now,
    });
    expect(plan.drop).toEqual([{ id: "p1", symbol: "MKS.L", reason: "expired", notionalBase: 90 }]);
  });

  it("expires a parked intent older than the window", () => {
    const plan = planBatchWindow({
      incoming: [],
      parked: [
        { id: "p1", symbol: "MKS.L", quantity: 10, price: 9, notionalBase: 90, firstSeenAt: hoursAgo(30) },
      ],
      minTicketBase: 250,
      now,
    });
    expect(plan.drop[0]).toMatchObject({ id: "p1", reason: "expired" });
    expect(plan.release).toHaveLength(0);
  });

  it("drops a parked leg when the price has run away", () => {
    const plan = planBatchWindow({
      incoming: [buy("MKS.L", 10, 10, 100)],
      parked: [
        { id: "p1", symbol: "MKS.L", quantity: 20, price: 9, notionalBase: 180, firstSeenAt: hoursAgo(3) },
      ],
      minTicketBase: 250,
      now,
    });
    expect(plan.drop[0]).toMatchObject({ id: "p1", reason: "price_drift" });
    expect(plan.park[0]!.quantity).toBe(10);
  });

  it("matches broker-native parked symbols against order symbols", () => {
    const plan = planBatchWindow({
      incoming: [buy("MKS.L", 20, 9, 180)],
      parked: [
        { id: "p1", symbol: "MKS:xlon", quantity: 20, price: 9, notionalBase: 180, firstSeenAt: hoursAgo(4) },
      ],
      minTicketBase: 250,
      now,
    });
    expect(plan.release[0]!.order.quantity).toBe(40);
  });

  it("keeps the original first-seen clock when topping up", () => {
    const plan = planBatchWindow({
      incoming: [buy("MKS.L", 5, 9, 45)],
      parked: [
        { id: "p1", symbol: "MKS.L", quantity: 5, price: 9, notionalBase: 45, firstSeenAt: hoursAgo(10) },
      ],
      minTicketBase: 250,
      now,
    });
    expect(plan.park[0]!.firstSeenAt).toBe(hoursAgo(10));
    expect(plan.park[0]!.expiresAt).toBe(new Date(now.getTime() + 14 * 3_600_000).toISOString());
  });
});
