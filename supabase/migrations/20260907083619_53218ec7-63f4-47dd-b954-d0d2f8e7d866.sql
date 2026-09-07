update public.live_fills
set
  fee = case broker_trade_id
    when '6852880685' then 3.98
    when '6854799886' then 3.45
  end,
  fee_other = case broker_trade_id
    when '6852880685' then 3.98
    when '6854799886' then 3.45
  end,
  fee_source = 'broker',
  fee_sync_status = 'invoiced',
  fee_sync_reason = null,
  fee_synced_at = now(),
  fee_sync_attempted_at = now()
where broker_trade_id in ('6852880685', '6854799886')
  and upper(symbol) = 'TSLA';