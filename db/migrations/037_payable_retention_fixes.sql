-- Correções da retenção (036). A 036 já foi aplicada e não muda.
-- 1) Só o acréscimo (accrual) espera o prazo. O estorno (reversal) conta na hora: create_payout e payable_buckets
--    tratam o estorno como liberado, para um estorno recente nunca deixar o repasse pagar valor que já foi devolvido.
-- 2) payable_buckets muda de colunas (por isso drop + create, não create or replace). Semântica, sobre os
--    lançamentos que nenhum repasse pegou (menos in_payout):
--      soma_liberada = soma de (estorno de qualquer idade) + (acréscimo com idade >= prazo); tem sinal.
--      released      = greatest(0, soma_liberada)  -> o que o repasse pode pagar agora (líquido; nunca negativo).
--      debt          = greatest(0, -soma_liberada) -> estorno a compensar com acréscimos futuros.
--      retained      = soma dos acréscimos ainda dentro do prazo (>= 0; estorno nunca entra aqui).
--      in_payout     = soma dos lançamentos em repasse ABERTO (status 'open'): o dinheiro não some entre
--                      create_payout e mark_payout_paid. Repasse cancelado devolve os itens; pago vira "paid".
--      next_release_at = created_at do acréscimo retido mais antigo + prazo.
-- 3) create_payout leva estorno de qualquer data (não só até o corte) e o acréscimo até o corte.

drop function if exists payable_buckets(uuid);

create function payable_buckets(p_bureau_id uuid)
returns table (released numeric, retained numeric, debt numeric, in_payout numeric, next_release_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_days integer := public.payable_retention_days();
  v_limit timestamptz;
begin
  if not public.app_context_present()
     or p_bureau_id is null
     or not (
       (public.app_user_role() in ('bureau_admin', 'operator')
         and p_bureau_id = public.app_bureau_id() and (select public.app_is_staff()))
       or (public.app_user_role() = 'superadmin' and public.app_support_session_id() is null)
     ) then
    return;
  end if;

  v_limit := pg_catalog.now() - pg_catalog.make_interval(days => v_days);
  return query
    with t as (
      select e.amount, e.kind, e.created_at, i.entry_id as item_id, p.status as payout_status
        from public.bureau_payable_entries e
        left join public.payout_items i on i.entry_id = e.id
        left join public.payouts p on p.id = i.payout_id
       where e.bureau_id = p_bureau_id
         and e.kind in ('accrual', 'reversal')
    ), s as (
      select coalesce(sum(amount) filter (
               where item_id is null and (kind = 'reversal' or created_at <= v_limit)), 0) as free_sum,
             coalesce(sum(amount) filter (
               where item_id is null and kind = 'accrual' and created_at > v_limit), 0) as retained_sum,
             coalesce(sum(amount) filter (where payout_status = 'open'), 0) as open_sum,
             min(created_at) filter (
               where item_id is null and kind = 'accrual' and created_at > v_limit) as first_retained
        from t
    )
    select greatest(0, s.free_sum)::numeric(15,2),
           s.retained_sum::numeric(15,2),
           greatest(0, -s.free_sum)::numeric(15,2),
           s.open_sum::numeric(15,2),
           s.first_retained + pg_catalog.make_interval(days => v_days)
      from s;
end
$$;

create or replace function create_payout(p_bureau_id uuid, p_cutoff_at timestamptz)
returns table (ok boolean, reason text, payout_id uuid, amount numeric)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_ids uuid[];
  v_amount numeric;
  v_payout uuid;
begin
  if not public.app_context_present()
     or public.app_user_role() is distinct from 'superadmin'
     or public.app_support_session_id() is not null then
    return query select false, 'not_allowed'::text, null::uuid, null::numeric;
    return;
  end if;
  if p_cutoff_at is null then
    return query select false, 'invalid_cutoff'::text, null::uuid, null::numeric;
    return;
  end if;
  if p_bureau_id is null or not exists (select 1 from public.bureaus b where b.id = p_bureau_id) then
    return query select false, 'not_found'::text, null::uuid, null::numeric;
    return;
  end if;
  if p_cutoff_at > pg_catalog.now() - pg_catalog.make_interval(days => public.payable_retention_days()) then
    return query select false, 'cutoff_within_retention'::text, null::uuid, null::numeric;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payout:' || p_bureau_id::text, 0));

  -- Estorno conta sempre; acréscimo só até o corte (que já respeita a retenção).
  select array_agg(e.id), sum(e.amount) into v_ids, v_amount
    from public.bureau_payable_entries e
   where e.bureau_id = p_bureau_id
     and e.kind in ('accrual', 'reversal')
     and (e.kind = 'reversal' or e.created_at <= p_cutoff_at)
     and not exists (select 1 from public.payout_items i where i.entry_id = e.id);
  if v_ids is null or v_amount <= 0 then
    return query select false, 'nothing_to_pay'::text, null::uuid, null::numeric;
    return;
  end if;

  insert into public.payouts (bureau_id, cutoff_at, amount, created_by)
  values (p_bureau_id, p_cutoff_at, v_amount, public.app_user_id())
  returning id into v_payout;
  insert into public.payout_items (payout_id, entry_id, bureau_id)
  select v_payout, e.id, e.bureau_id
    from public.bureau_payable_entries e where e.id = any(v_ids);

  return query select true, null::text, v_payout, v_amount;
end
$$;

alter function payable_buckets(uuid) owner to auth_profile_lookup;
alter function create_payout(uuid, timestamptz) owner to auth_profile_lookup;

revoke all on function payable_buckets(uuid) from public;
grant execute on function payable_buckets(uuid) to app_runtime;
