update public.live_fills
set
  fee = case broker_trade_id
    when '6852880685' then 5.38
    when '6854799886' then 4.66
  end,
  fee_commission = 0,
  fee_exchange = 0,
  fee_tax = 0,
  fee_other = case broker_trade_id
    when '6852880685' then 5.38
    when '6854799886' then 4.66
  end,
  fee_source = 'broker',
  fee_sync_status = 'invoiced',
  fee_sync_reason = null,
  fee_synced_at = now(),
  fee_sync_attempted_at = now()
where broker_trade_id in ('6852880685', '6854799886')
  and upper(symbol) = 'TSLA';