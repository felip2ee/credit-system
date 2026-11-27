-- O afiliado em modo conta Asaas recebe pelo split: as linhas estão só em charge_splits, que o cliente não lê
-- (charge_splits_select, 070). Em vez de uma política na tabela (a linha tem walletId), uma função definer devolve só as
-- linhas asaas do próprio afiliado, no Bureau da sessão, com a seção ligada, e só o que a página mostra.
-- Linha em modo Pix fica de fora: ela já vem de affiliate_commissions (nenhuma cobrança aparece duas vezes).
-- Cobrança não paga fica de fora (o plano nasce com a cobrança), salvo se o repasse já saiu.
-- status: o da linha; com o dinheiro devolvido, done vira reversal_failed (reversão pendente) e pending vira refunded.
create index if not exists charge_splits_affiliate_idx on charge_splits(beneficiary_id, created_at desc) where beneficiary_kind = 'affiliate';

create or replace function affiliate_my_asaas_commissions()
returns table (created_at timestamptz, referred_name text, referred_at timestamptz, base_value numeric, amount numeric,
               status text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select c.created_at, p.full_name, r.created_at, c.amount, (s.amount_cents / 100.0)::numeric(15,2),
         case
           when x.returned and s.status = 'done' then 'reversal_failed'
           when x.returned and s.status = 'pending' then 'refunded'
           else s.status
         end
    from public.charge_splits s
    join public.pix_charges c on c.id = s.pix_charge_id and c.bureau_id = s.bureau_id
    join public.profiles p on p.id = c.client_profile_id
    left join public.affiliate_referrals r
      on r.referred_profile_id = c.client_profile_id and r.affiliate_profile_id = s.beneficiary_id
     and r.bureau_id = s.bureau_id
   cross join lateral (select public.pix_charge_returned(c.id) as returned) x
   where public.app_context_present() and public.app_user_role() = 'client' and public.affiliate_enabled()
     and s.beneficiary_kind = 'affiliate' and s.payout_method = 'asaas'
     and s.beneficiary_id = public.app_user_id() and s.bureau_id = public.app_bureau_id()
     and (c.status in ('paid', 'refunded') or s.status in ('done', 'reversal_failed'))
   order by c.created_at desc
$$;

alter function affiliate_my_asaas_commissions() owner to auth_profile_lookup;
revoke all on function affiliate_my_asaas_commissions() from public;
grant execute on function affiliate_my_asaas_commissions() to app_runtime;
