-- Com a 063, open_order deixa o pedido online sem reserva em awaiting_payment. O pedido que reserva o saldo na hora
-- (placeOrder) precisa sair desse estado quando a reserva nasce, e o cliente não atualiza dossier_orders (só a equipe
-- e as funções definer). Este gatilho chama refresh_order_state na mesma transação da reserva (reserve_order).
-- O webhook do PIX do pedido (065) cai no mesmo gatilho: reservar já avança o pedido.

create function order_settlements_refresh_online()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.refresh_order_state(new.order_ref);
  return null;
end
$$;
alter function order_settlements_refresh_online() owner to auth_profile_lookup;
revoke all on function order_settlements_refresh_online() from public;

create trigger order_settlements_refresh_online after insert on order_settlements
  for each row when (new.mode = 'online' and new.status in ('reserved', 'captured'))
  execute function order_settlements_refresh_online();
