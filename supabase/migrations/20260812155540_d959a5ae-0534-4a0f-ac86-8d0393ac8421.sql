-- Align table privileges with the RLS policies that actually exist.
-- Both tables are written exclusively by server-side jobs running as
-- service_role (broker-instrument-blocks.server.ts,
-- corporate-action-deadline-alerts.server.ts); the client only reads its own
-- rows, plus deletes its own broker block events. The blanket ALL grants on
-- broker_block_events (including to anon) exceeded that by a wide margin.

REVOKE ALL ON public.broker_block_events FROM anon;
REVOKE ALL ON public.broker_block_events FROM authenticated;
GRANT SELECT, DELETE ON public.broker_block_events TO authenticated;
GRANT ALL ON public.broker_block_events TO service_role;

REVOKE ALL ON public.corporate_action_alerts_sent FROM anon;
REVOKE ALL ON public.corporate_action_alerts_sent FROM authenticated;
GRANT SELECT ON public.corporate_action_alerts_sent TO authenticated;
GRANT ALL ON public.corporate_action_alerts_sent TO service_role;