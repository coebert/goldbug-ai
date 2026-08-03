UPDATE public.live_fills
   SET quantity = 445
 WHERE id = '0c18cc68-8664-48a0-94dc-e61cc8879cd3';

INSERT INTO public.live_fills
  (portfolio_id, user_id, order_id, symbol, side, quantity, fill_price, fee, currency, broker_fill_id, filled_at)
SELECT 'd7567038-0241-42f2-83ea-95925a4073ed', user_id, order_id, symbol, side, 446, fill_price, 0, currency,
       broker_fill_id || ':split-balanced', filled_at
  FROM public.live_fills
 WHERE id = '0c18cc68-8664-48a0-94dc-e61cc8879cd3'
   AND NOT EXISTS (
     SELECT 1 FROM public.live_fills WHERE broker_fill_id = '5039438447:split-balanced'
   );

UPDATE public.live_fills
   SET portfolio_id = 'd7567038-0241-42f2-83ea-95925a4073ed'
 WHERE id = 'f731142d-814c-4c99-bd81-d05dd395b7ac';
