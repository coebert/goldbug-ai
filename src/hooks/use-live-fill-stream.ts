// Streams broker fill/order changes for one portfolio so P&L views can refresh
// the moment a real trade fills, instead of waiting for the next poll.
import { useEffect, useId, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type LiveFillStream = {
  /** How many fill/order events arrived since mounting. */
  events: number;
  /** When the last event arrived. */
  lastEventAt: Date | null;
  /** Whether the realtime channel is connected. */
  connected: boolean;
};

/**
 * Subscribe to live_fills and live_orders for a portfolio and call `onChange`
 * (debounced) whenever the broker reports something new.
 */
export function useLiveFillStream(
  portfolioId: string | null,
  onChange: () => void,
  debounceMs = 1200,
): LiveFillStream {
  const [events, setEvents] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);
  // Each subscriber gets its own channel name: Supabase rejects extra
  // postgres_changes bindings on a channel that has already subscribed, so a
  // shared name breaks whichever panel mounts second.
  const instanceId = useId();
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!portfolioId) {
      setConnected(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      setEvents((n) => n + 1);
      setLastEventAt(new Date());
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cb.current(), debounceMs);
    };

    const channel = supabase
      .channel(`pnl-live-${portfolioId}-${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "live_fills",
          filter: `portfolio_id=eq.${portfolioId}`,
        },
        bump,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "live_orders",
          filter: `portfolio_id=eq.${portfolioId}`,
        },
        bump,
      )
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));

    return () => {
      if (timer) clearTimeout(timer);
      setConnected(false);
      supabase.removeChannel(channel);
    };
  }, [portfolioId, debounceMs, instanceId]);

  return { events, lastEventAt, connected };
}
