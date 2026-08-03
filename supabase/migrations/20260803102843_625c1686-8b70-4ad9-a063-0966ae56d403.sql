INSERT INTO public.broker_instrument_blocks
  (user_id, portfolio_id, broker, symbol, symbol_key, reason, detail, reject_reason)
VALUES (
  '131e88aa-a805-4bcf-9bff-720699eea6e8',
  '7c825889-81a1-4c32-9087-26d3847be6b1',
  'saxo',
  'SGLN.L',
  'SGLN',
  'suitability',
  'Broker suitability/appropriateness test not completed for this product type.',
  'The order has been rejected because the instrument is not currently suitable for you or because a suitability test has not been taken.'
)
ON CONFLICT (user_id, broker, symbol_key) DO NOTHING;