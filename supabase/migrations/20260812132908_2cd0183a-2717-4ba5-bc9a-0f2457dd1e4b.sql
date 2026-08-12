create policy "Users update own order explanations"
on public.order_explanations
for update
to authenticated
using (exists (select 1 from decisions d join portfolios p on p.id = d.portfolio_id
  where d.id::text = order_explanations.decision_id and p.user_id = auth.uid()))
with check (exists (select 1 from decisions d join portfolios p on p.id = d.portfolio_id
  where d.id::text = order_explanations.decision_id and p.user_id = auth.uid()));

create policy "Users delete own order explanations"
on public.order_explanations
for delete
to authenticated
using (exists (select 1 from decisions d join portfolios p on p.id = d.portfolio_id
  where d.id::text = order_explanations.decision_id and p.user_id = auth.uid()));

grant select, insert, update, delete on public.order_explanations to authenticated;
grant all on public.order_explanations to service_role;