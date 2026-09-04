import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  closeBrokerPriceStream,
  openBrokerPriceStream,
  type BrokerStreamSession,
} from "@/lib/broker-stream.functions";
import { nativeQuotePrice } from "@/lib/market-price-units";

export type StreamedQuote = {
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  currency: string;
  at: string;
};

export type BrokerStreamState = {
  /** Latest pushed price per broker-native symbol, in native quote units. */
  quotes: Record<string, StreamedQuote>;
  status: "idle" | "connecting" | "live" | "reconnecting" | "unavailable";
  /** Wall-clock of the last tick applied, for the "as of" label. */
  lastTickAt: number | null;
  reason: string | null;
};

/**
 * Saxo's streaming frame: 8-byte message id, 2 reserved, 1-byte reference-id
 * length, the reference id, 1-byte payload format, 4-byte payload length, then
 * the payload. Several frames can share one socket message.
 */
function decodeFrames(buf: ArrayBuffer): Array<{ messageId: number; referenceId: string; payload: unknown }> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const out: Array<{ messageId: number; referenceId: string; payload: unknown }> = [];
  let i = 0;
  while (i + 16 <= buf.byteLength) {
    const messageId = Number(view.getBigUint64(i, true));
    const refLen = view.getUint8(i + 10);
    const refStart = i + 11;
    const referenceId = new TextDecoder().decode(bytes.subarray(refStart, refStart + refLen));
    const fmt = view.getUint8(refStart + refLen);
    const sizeAt = refStart + refLen + 1;
    const payloadSize = view.getUint32(sizeAt, true);
    const payloadStart = sizeAt + 4;
    const payloadEnd = payloadStart + payloadSize;
    if (payloadEnd > buf.byteLength) break;
    let payload: unknown = null;
    if (fmt === 0) {
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes.subarray(payloadStart, payloadEnd)));
      } catch {
        payload = null;
      }
    }
    out.push({ messageId, referenceId, payload });
    i = payloadEnd;
  }
  return out;
}

function positive(...values: Array<unknown>): number {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

type Meta = { symbol: string; currency: string };

/**
 * Hold a Saxo streaming price socket open for a portfolio's positions.
 *
 * Prices arrive as the venue prints them instead of on a poll timer. The hook
 * degrades quietly: any failure leaves `status: "unavailable"` and no quotes,
 * so the caller's polled prices remain the source of truth.
 */
export function useBrokerPriceStream(portfolioId: string | null, enabled = true): BrokerStreamState {
  const open = useServerFn(openBrokerPriceStream);
  const close = useServerFn(closeBrokerPriceStream);
  const [quotes, setQuotes] = useState<Record<string, StreamedQuote>>({});
  const [status, setStatus] = useState<BrokerStreamState["status"]>("idle");
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const metaRef = useRef<Map<string, Meta>>(new Map());
  const contextRef = useRef<string | null>(null);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  const applyTick = useCallback((referenceId: string, payload: unknown) => {
    const meta = metaRef.current.get(referenceId);
    if (!meta || !payload || typeof payload !== "object") return;
    const p = payload as {
      Quote?: { Bid?: number; Ask?: number; Mid?: number };
      PriceInfoDetails?: { LastTraded?: number; LastClose?: number };
      DisplayAndFormat?: { Currency?: string };
      LastUpdated?: string;
    };
    const ccy = String(p.DisplayAndFormat?.Currency ?? meta.currency ?? "GBP");
    const bidRaw = positive(p.Quote?.Bid) || null;
    const askRaw = positive(p.Quote?.Ask) || null;
    const mid = bidRaw != null && askRaw != null ? (bidRaw + askRaw) / 2 : null;
    const raw = positive(p.Quote?.Mid, mid, p.PriceInfoDetails?.LastTraded, p.PriceInfoDetails?.LastClose);
    if (!(raw > 0)) return;
    setQuotes((prev) => ({
      ...prev,
      [meta.symbol]: {
        symbol: meta.symbol,
        price: nativeQuotePrice(meta.symbol, raw, ccy),
        bid: bidRaw == null ? null : nativeQuotePrice(meta.symbol, bidRaw, ccy),
        ask: askRaw == null ? null : nativeQuotePrice(meta.symbol, askRaw, ccy),
        currency: ccy,
        at: p.LastUpdated ?? new Date().toISOString(),
      },
    }));
    setLastTickAt(Date.now());
  }, []);

  useEffect(() => {
    if (!portfolioId || !enabled || typeof window === "undefined") {
      setStatus("idle");
      return;
    }
    stoppedRef.current = false;
    let cancelled = false;

    const scheduleRetry = () => {
      if (stoppedRef.current || cancelled) return;
      attemptRef.current += 1;
      if (attemptRef.current > 6) {
        setStatus("unavailable");
        return;
      }
      setStatus("reconnecting");
      const wait = Math.min(30_000, 2_000 * 2 ** (attemptRef.current - 1));
      retryTimerRef.current = setTimeout(() => void start(), wait);
    };

    const start = async () => {
      if (stoppedRef.current || cancelled) return;
      setStatus((s) => (s === "live" ? s : attemptRef.current > 0 ? "reconnecting" : "connecting"));
      let session: BrokerStreamSession;
      try {
        session = (await open({ data: { portfolioId } })) as BrokerStreamSession;
      } catch {
        setReason("broker-error");
        scheduleRetry();
        return;
      }
      if (cancelled || stoppedRef.current) return;
      if (!session.ok) {
        setReason(session.reason);
        // Nothing to stream (no positions, no broker link): stay quiet.
        setStatus("unavailable");
        return;
      }
      setReason(null);
      contextRef.current = session.contextId;
      metaRef.current = new Map(
        session.subscriptions.map((s) => [s.referenceId, { symbol: s.symbol, currency: s.currency }]),
      );
      // Seed with the subscription snapshots so the page is correct before the
      // first tick lands.
      setQuotes((prev) => {
        const next = { ...prev };
        for (const s of session.ok ? session.subscriptions : []) {
          if (s.price != null && s.price > 0) {
            next[s.symbol] = {
              symbol: s.symbol, price: s.price, bid: s.bid, ask: s.ask,
              currency: s.currency, at: s.at,
            };
          }
        }
        return next;
      });

      let ws: WebSocket;
      try {
        ws = new WebSocket(session.wsUrl);
      } catch {
        scheduleRetry();
        return;
      }
      ws.binaryType = "arraybuffer";
      socketRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        setStatus("live");
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        for (const frame of decodeFrames(ev.data)) {
          if (frame.referenceId === "_heartbeat") continue;
          if (frame.referenceId === "_disconnect" || frame.referenceId === "_resetsubscriptions") {
            // Saxo asks us to rebuild: drop the socket and re-subscribe.
            try { ws.close(); } catch { /* already closing */ }
            return;
          }
          applyTick(frame.referenceId, frame.payload);
        }
      };
      ws.onerror = () => { /* close handler drives the retry */ };
      ws.onclose = () => {
        socketRef.current = null;
        if (stoppedRef.current || cancelled) return;
        scheduleRetry();
      };
    };

    void start();

    return () => {
      cancelled = true;
      stoppedRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      const sock = socketRef.current;
      socketRef.current = null;
      try { sock?.close(); } catch { /* noop */ }
      const ctx = contextRef.current;
      contextRef.current = null;
      if (ctx) void close({ data: { portfolioId, contextId: ctx } }).catch(() => {});
    };
  }, [portfolioId, enabled, open, close, applyTick]);

  return useMemo(
    () => ({ quotes, status, lastTickAt, reason }),
    [quotes, status, lastTickAt, reason],
  );
}
