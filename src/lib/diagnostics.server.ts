// Server-only helpers for portfolio diagnostics.

export type ExecutedOrder = {
  symbol?: string;
  side?: string;
  price?: number;
  quantity?: number;
  rejected?: string | null;
  reason?: string;
};

export type AiOrder = {
  symbol?: string;
  side?: string;
  percent?: number;
  signal_weights?: Record<string, number>;
};

export const SIGNAL_KEYS = [
  "sma_trend",
  "rsi",
  "price_change",
  "news_sentiment",
  "volatility",
] as const;

export function addBusinessDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
