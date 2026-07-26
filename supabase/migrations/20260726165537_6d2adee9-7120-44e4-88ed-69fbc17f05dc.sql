ALTER PUBLICATION supabase_realtime ADD TABLE public.decisions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_fills;
ALTER TABLE public.decisions REPLICA IDENTITY FULL;
ALTER TABLE public.live_fills REPLICA IDENTITY FULL;