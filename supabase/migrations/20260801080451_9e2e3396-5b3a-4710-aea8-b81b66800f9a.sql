-- One broker account may back at most one portfolio. Sharing an account makes
-- every sync write the same broker snapshot into both books (mirrored
-- holdings/equity), which is what the mirror detector reports.
CREATE UNIQUE INDEX IF NOT EXISTS portfolios_unique_broker_account
  ON public.portfolios (broker, broker_account_id)
  WHERE broker_account_id IS NOT NULL;