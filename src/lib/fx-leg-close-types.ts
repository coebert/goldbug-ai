// Result shape shared by the manual close button and the automatic sweep.
export type CloseFxLegResult =
  | {
      ok: true;
      symbol: string;
      pair: string;
      direction: "short" | "long";
      rate: number;
      amountFrom: number;
      fromCcy: string;
      amountTo: number;
      toCcy: string;
      feeQuote: number;
      pnlQuoteNet: number;
      execution: "spot" | "wallet";
      brokerOrderId: string | null;
    }
  | { ok: false; reason: string; detail: string };
