-- Fecha a brecha do limite de tentativas (052): o pedido (placeOrder) valida o cupom na mesma transação da reserva e,
-- se o código é inválido, dá rollback. O erro gravado por coupon_preview se perde, e um cliente adivinharia códigos
-- pela ação do pedido sem ser contado. O TypeScript chama esta função numa transação própria, depois do rollback.
-- Quem chama é o contexto da sessão (app_user_id/app_bureau_id): sem parâmetros e sem retorno, então não diz se o
-- código existe. Só cliente grava; no limite não grava mais (a tabela não cresce com quem insiste).

create function coupon_record_miss()
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
begin
  if not public.app_context_present() or v_bureau is null or v_user is null
     or public.app_user_role() is distinct from 'client' then
    raise exception 'coupon_record_miss: not allowed' using errcode = '42501';
  end if;
  if public.coupon_attempts_blocked(v_user) then
    return;
  end if;
  insert into public.coupon_attempt_misses (profile_id, bureau_id) values (v_user, v_bureau);
end
$$;

alter function coupon_record_miss() owner to auth_profile_lookup;
revoke all on function coupon_record_miss() from public;
grant execute on function coupon_record_miss() to app_runtime;
