update public.live_fills
set
  fee = case broker_trade_id
    when '6852880685' then 5.38
    when '6854799886' then 4.66
  end,
  fee_other = case broker_trade_id
    when '6852880685' then 5.38
    when '6854799886' then 4.66
  end
where broker_trade_id in ('6852880685', '6854799886')
  and upper(symbol) = 'TSLA'
  and currency = 'USD'
  and fee_source = 'broker';