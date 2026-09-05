-- User-adjustable cost hurdle multiple for the net-of-cost edge gate.
-- The effective round-trip hurdle a buy must clear is
--   max(modelled friction, measured fill cost x headroom) x cost_hurdle_multiple.
-- Default 1.25 matches the tuned DEFAULT_EDGE_SAFETY_MULTIPLE so existing
-- behaviour is unchanged until the slider is moved. Sells are never gated.
ALTER TABLE public.trading_controls
  ADD COLUMN IF NOT EXISTS cost_hurdle_multiple numeric NOT NULL DEFAULT 1.25;

COMMENT ON COLUMN public.trading_controls.cost_hurdle_multiple IS
  'Safety multiple applied to the round-trip cost floor in the net-edge gate (Costs page slider). 1.0 = break-even, higher = fewer, larger-edge buys.';