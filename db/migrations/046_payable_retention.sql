-- Retenção do valor a receber: o repasse só paga lançamento com idade maior ou igual ao prazo.
-- 1) settings.payable_retention_days: dias de retenção, um valor para todos os Bureaus (só o superadmin altera).
--    Inteiro de 0 a 3650. Um check na tabela recusa outro valor para esta chave.
-- 2) payable_retention_days() lê o prazo; ausente ou inválido volta 30.
-- 3) payable_buckets(bureau) separa o que já pode ser repassado (released) do que ainda está retido (retained),
--    sobre os lançamentos accrual e reversal que nenhum repasse pegou. Nunca devolve valor abaixo de zero.
--    A data de liberação não tem coluna: é created_at + prazo, calculada na leitura.
-- 4) create_payout recusa um corte depois de now() − prazo (cutoff_within_retention). O resto não muda (016).

insert into settings (key, value, description) values
  ('payable_retention_days', '30'::jsonb, 'Dias de retenção do valor a receber antes de poder ser repassado')
on conflict (key) do nothing;

alter table settings add constraint settings_payable_retention_days_check check (
  key <> 'payable_retention_days'
  or case
       when jsonb_typeof(value) = 'number'
         then (value #>> '{}')::numeric between 0 and 3650
              and (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
       else false
     end
);

-- As funções abaixo são do auth_profile_lookup e leem só esta chave (molde da carência de afiliados, 027).
create policy settings_gateway_payable_retention on settings for select to auth_profile_lookup
  using (key = 'payable_retention_days');

-- O prazo não é segredo e create_payout (definer) precisa dele: qualquer contexto pode ler.
create function payable_retention_days()
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select (s.n)::integer
       from (select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric end as n
               from public.settings where key = 'payable_retention_days') s
      where s.n between 0 and 3650 and s.n = trunc(s.n)),
    30)
$$;

-- Equipe do próprio Bureau (admin e operador) e superadmin sem suporte. Outro chamador recebe zero linhas.
create function payable_buckets(p_bureau_id uuid)
returns table (released numeric, retained numeric, next_release_at timestamptz)
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
    select greatest(0, coalesce(sum(e.amount) filter (where e.created_at <= v_limit), 0))::numeric(15,2),
           greatest(0, coalesce(sum(e.amount) filter (where e.created_at > v_limit), 0))::numeric(15,2),
           min(e.created_at) filter (where e.created_at > v_limit) + pg_catalog.make_interval(days => v_days)
      from public.bureau_payable_entries e
     where e.bureau_id = p_bureau_id
       and e.kind in ('accrual', 'reversal')
       and not exists (select 1 from public.payout_items i where i.entry_id = e.id);
end
$$;

-- create_payout de 016, com a recusa do corte dentro da retenção depois da checagem do Bureau.
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

  select array_agg(e.id), sum(e.amount) into v_ids, v_amount
    from public.bureau_payable_entries e
   where e.bureau_id = p_bureau_id
     and e.kind in ('accrual', 'reversal')
     and e.created_at <= p_cutoff_at
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

alter function payable_retention_days() owner to auth_profile_lookup;
alter function payable_buckets(uuid) owner to auth_profile_lookup;
alter function create_payout(uuid, timestamptz) owner to auth_profile_lookup;

revoke all on function payable_retention_days() from public;
revoke all on function payable_buckets(uuid) from public;
grant execute on function payable_retention_days() to app_runtime;
grant execute on function payable_buckets(uuid) to app_runtime;
