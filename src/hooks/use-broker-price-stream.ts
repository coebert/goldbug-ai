import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  closeBrokerPriceStream,
  openBrokerPriceStream,
  subscribeBrokerPrices,
  type BrokerStreamSession,
  type BrokerStreamSubscribeResult,
} from "@/lib/broker-stream.functions";
import { nativeQuotePrice } from "@/lib/market-price-units";

export type StreamedQuote = {
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  currency: string;
  at: string;
  /** True once the venue has pushed at least one update for this line. */
  streamed: boolean;
};

export type BrokerStreamState = {
  /** Latest price per broker-native symbol, in native quote units. */
  quotes: Record<string, StreamedQuote>;
  /**
   * `connecting` → socket opening; `subscribed` → socket open and
   * subscriptions placed but nothing pushed yet; `live` → ticks arriving.
   * The distinction matters: a connected socket on a closed market pushes
   * nothing, and calling that "live" is what made the badge lie.
   */
  status: "idle" | "connecting" | "subscribed" | "live" | "reconnecting" | "unavailable";
  /** Wall-clock of the last pushed tick applied. */
  lastTickAt: number | null;
  /** How many price updates the venue has pushed this session. */
  tickCount: number;
  /** Symbols the venue has actually pushed at least one update for. */
  streamedSymbols: string[];
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

type PriceRow = {
  Uic?: number;
  Quote?: { Bid?: number; Ask?: number; Mid?: number };
  PriceInfoDetails?: { LastTraded?: number; LastClose?: number };
  DisplayAndFormat?: { Currency?: string };
  LastUpdated?: string;
};

type Meta = { symbol: string; currency: string };

/**
 * Fold a delta row into the last known row for that instrument.
 *
 * Saxo deltas are PARTIAL: a frame may carry only `Quote.Ask`, or only
 * `PriceInfoDetails`. Treating each frame as a whole quote threw away most
 * ticks (an ask-only update has no derivable mid), which is why prices looked
 * frozen behind a connected socket.
 */
export function mergePriceRow(prev: PriceRow | undefined, next: PriceRow): PriceRow {
  return {
    ...prev,
    ...next,
    Quote: { ...prev?.Quote, ...next.Quote },
    PriceInfoDetails: { ...prev?.PriceInfoDetails, ...next.PriceInfoDetails },
    DisplayAndFormat: { ...prev?.DisplayAndFormat, ...next.DisplayAndFormat },
  };
}

/** Best available price from a merged row: mid, else traded, else close. */
export function rowPrice(row: PriceRow): { raw: number; bid: number | null; ask: number | null } {
  const bid = positive(row.Quote?.Bid) || null;
  const ask = positive(row.Quote?.Ask) || null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  return {
    raw: positive(row.Quote?.Mid, mid, row.PriceInfoDetails?.LastTraded, row.PriceInfoDetails?.LastClose),
    bid,
    ask,
  };
}

/**
 * Hold a Saxo streaming price socket open for a portfolio's positions.
 *
 * Order matters: connect the socket, THEN create the subscriptions on that
 * context, so the snapshot and every delta land on a live connection. The hook
 * degrades quietly: any failure leaves no ticks and the caller's polled prices
 * remain the source of truth.
 */
export function useBrokerPriceStream(portfolioId: string | null, enabled = true): BrokerStreamState {
  const open = useServerFn(openBrokerPriceStream);
  const subscribe = useServerFn(subscribeBrokerPrices);
  const close = useServerFn(closeBrokerPriceStream);
  const [quotes, setQuotes] = useState<Record<string, StreamedQuote>>({});
  const [status, setStatus] = useState<BrokerStreamState["status"]>("idle");
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [tickCount, setTickCount] = useState(0);
  const [reason, setReason] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  // Keyed by Saxo UIC: list subscriptions push one frame per reference id
  // carrying rows for many instruments.
  const metaRef = useRef<Map<number, Meta>>(new Map());
  const rowsRef = useRef<Map<number, PriceRow>>(new Map());
  const contextRef = useRef<string | null>(null);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  const applyOne = useCallback((row: unknown) => {
    if (!row || typeof row !== "object") return;
    const uic = Number((row as PriceRow).Uic);
    const meta = metaRef.current.get(uic);
    if (!meta) return;
    const merged = mergePriceRow(rowsRef.current.get(uic), row as PriceRow);
    rowsRef.current.set(uic, merged);
    const { raw, bid, ask } = rowPrice(merged);
    if (!(raw > 0)) return;
    const ccy = String(merged.DisplayAndFormat?.Currency ?? meta.currency ?? "GBP");
    setQuotes((prev) => ({
      ...prev,
      [meta.symbol]: {
        symbol: meta.symbol,
        price: nativeQuotePrice(meta.symbol, raw, ccy),
        bid: bid == null ? null : nativeQuotePrice(meta.symbol, bid, ccy),
        ask: ask == null ? null : nativeQuotePrice(meta.symbol, ask, ccy),
        currency: ccy,
        at: merged.LastUpdated ?? new Date().toISOString(),
        streamed: true,
      },
    }));
    setLastTickAt(Date.now());
    setTickCount((n) => n + 1);
    setStatus((s) => (s === "unavailable" ? s : "live"));
  }, []);

  /** One delta frame carries either a single price row or a list of them. */
  const applyTick = useCallback((payload: unknown) => {
    if (Array.isArray(payload)) for (const row of payload) applyOne(row);
    else applyOne(payload);
  }, [applyOne]);

  useEffect(() => {
    if (!portfolioId || !enabled || typeof window === "undefined") {
      setStatus("idle");
      return;
    }
    stoppedRef.current = false;
    let cancelled = false;

    const clearWatchdog = () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    };

    const scheduleRetry = () => {
      clearWatchdog();
      if (stoppedRef.current || cancelled) return;
      attemptRef.current += 1;
      if (attemptRef.current > 6) {
        setStatus("unavailable");
        setReason("stream-lost");
        return;
      }
      setStatus("reconnecting");
      const wait = Math.min(30_000, 2_000 * 2 ** (attemptRef.current - 1));
      retryTimerRef.current = setTimeout(() => void start(), wait);
    };

    /**
     * Saxo sends a heartbeat on every idle interval. Silence past two of them
     * means the socket is dead in a way `onclose` will not report (a proxy
     * holding a half-open connection), so force a rebuild.
     */
    const armWatchdog = (idleSec: number, sock: WebSocket) => {
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        if (stoppedRef.current || cancelled) return;
        try { sock.close(); } catch { /* already closing */ }
      }, Math.max(20_000, idleSec * 2_000 + 5_000));
    };

    const start = async () => {
      if (stoppedRef.current || cancelled) return;
      setStatus((s) => (s === "live" ? s : attemptRef.current > 0 ? "reconnecting" : "connecting"));
      // Never leave an orphaned context behind on a retry: Saxo keeps
      // subscriptions alive until the socket connects or they time out.
      const stale = contextRef.current;
      contextRef.current = null;
      if (stale) void close({ data: { portfolioId, contextId: stale } }).catch(() => {});
      rowsRef.current = new Map();

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
        setStatus((s) => (s === "live" ? s : "connecting"));
        armWatchdog(30, ws);
        // Socket is up — now place the subscriptions on this context so the
        // snapshot and every delta have somewhere to arrive.
        void (async () => {
          let sub: BrokerStreamSubscribeResult;
          try {
            sub = (await subscribe({
              data: { portfolioId, contextId: session.ok ? session.contextId : "" },
            })) as BrokerStreamSubscribeResult;
          } catch {
            setReason("broker-error");
            try { ws.close(); } catch { /* already closing */ }
            return;
          }
          if (cancelled || stoppedRef.current) return;
          if (!sub.ok) {
            setReason(sub.reason);
            setStatus("unavailable");
            try { ws.close(); } catch { /* already closing */ }
            stoppedRef.current = true;
            return;
          }
          metaRef.current = new Map(
            sub.subscriptions.map((s) => [s.uic, { symbol: s.symbol, currency: s.currency }]),
          );
          // Seed with the subscription snapshots so the page is correct before
          // the first pushed tick lands. These are NOT marked as streamed.
          setQuotes((prev) => {
            const next = { ...prev };
            for (const s of sub.ok ? sub.subscriptions : []) {
              if (s.price != null && s.price > 0 && !next[s.symbol]?.streamed) {
                next[s.symbol] = {
                  symbol: s.symbol, price: s.price, bid: s.bid, ask: s.ask,
                  currency: s.currency, at: s.at, streamed: false,
                };
              }
            }
            return next;
          });
          setStatus((s) => (s === "live" ? s : "subscribed"));
          armWatchdog(sub.inactivityTimeoutSec, ws);
        })();
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        armWatchdog(30, ws);
        for (const frame of decodeFrames(ev.data)) {
          if (frame.referenceId === "_heartbeat") continue;
          if (frame.referenceId === "_disconnect" || frame.referenceId === "_resetsubscriptions") {
            // Saxo asks us to rebuild: drop the socket and re-subscribe.
            try { ws.close(); } catch { /* already closing */ }
            return;
          }
          applyTick(frame.payload);
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
      clearWatchdog();
      const sock = socketRef.current;
      socketRef.current = null;
      try { sock?.close(); } catch { /* noop */ }
      const ctx = contextRef.current;
      contextRef.current = null;
      if (ctx) void close({ data: { portfolioId, contextId: ctx } }).catch(() => {});
    };
  }, [portfolioId, enabled, open, subscribe, close, applyTick]);

  const streamedSymbols = useMemo(
    () => Object.values(quotes).filter((q) => q.streamed).map((q) => q.symbol),
    [quotes],
  );

  return useMemo(
    () => ({ quotes, status, lastTickAt, tickCount, streamedSymbols, reason }),
    [quotes, status, lastTickAt, tickCount, streamedSymbols, reason],
  );
}
