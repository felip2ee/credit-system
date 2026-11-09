-- Pedido de balcão para o próprio Titular do comprador (open_order) e correção do contato do pedido de autorização SCR
-- (update_order_contact). A 022 já foi aplicada e não muda.
--
-- 1) open_order, balcão: se o documento do Titular casa com um Titular da conta do comprador, é a pesquisa própria dele.
--    O servidor usa o e-mail da conta e o celular só se confirmado, descarta o contato digitado e não aplica
--    contact_is_buyer (D12). Terceiro de verdade segue sob D12. Sócio cujo documento é o de um Titular do comprador pode
--    usar o e-mail dele, também no balcão. dossier_orders.self_research continua só online (check dossier_orders_self_online).
-- 2) update_order_contact: troca e-mail e/ou celular do membro de um pedido que ainda espera a autorização e invalida o
--    link anterior (novo public_token, auth_code nulo, notificações em fila anuladas). O envio do link novo é do tick ou
--    da action (issueSelfScrAuthorization, que só grava se o token ainda é o lido). A auditoria fica na própria função,
--    na mesma transação, com e-mail mascarado.

create or replace function open_order(
  p_product_code text,
  p_self boolean,
  p_subject_type text,
  p_subject_name text,
  p_subject_document text,
  p_partners jsonb,
  p_contact_email text,
  p_contact_phone text,
  p_buyer_profile_id uuid
)
returns table (ok boolean, reason text, dossier_id uuid, state text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  -- Mesma forma de isValidEmail (src/lib/utils.ts): sem , ; ( ) < > " para o endereço não virar lista no nodemailer.
  c_email_re constant text := '^[^\s@,;()<>"]+@[^\s@,;()<>"]+\.[^\s@,;()<>"]+$';
  c_max_recent_requests constant integer := 3;
  -- Teto de pedidos online do mesmo cliente em 24 h: o teto por destinatário não segura quem abre, deixa o convite sair e cancela.
  c_max_online_orders_per_day constant integer := 5;
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_role text := public.app_user_role();
  v_mode text;
  v_self boolean := coalesce(p_self, false);
  v_partners jsonb := coalesce(nullif(p_partners, 'null'::jsonb), '[]'::jsonb);
  v_digits text := regexp_replace(coalesce(p_subject_document, ''), '\D', '', 'g');
  v_name text := btrim(coalesce(p_subject_name, ''));
  v_email text := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  v_phone text := nullif(btrim(coalesce(p_contact_phone, '')), '');
  v_buyer uuid;
  v_buyer_p record;
  v_own record;
  v_main record;
  v_kind_bad boolean;
  v_type text;
  v_acct_type text;
  v_self_member boolean := false;
  -- O Titular consultado é um Titular do comprador: pesquisa própria dele (online: v_self; balcão: achado pelo documento).
  v_subject_is_buyer boolean := false;
  v_partner_is_buyer boolean;
  v_buyer_as_company_contact boolean := false;
  v_deps_pf text;
  v_holder uuid;
  v_dossier uuid;
  v_members jsonb;
  v_member jsonb;
  v_partner jsonb;
  v_seen text[];
  v_i integer;
  v_h uuid;
  v_cid uuid;
  v_auth_id uuid;
  v_auth_email text;
  v_mdigits text;
  v_mname text;
  v_mtype text;
  v_memail text;
  v_recent integer;
  v_orders_today integer;
  v_pdigits text;
  v_pname text;
  v_pemail text;
  v_ppct numeric;
  v_prole text;
  v_state text;
  v_fail text;
begin
  -- 1) Contexto e papel. Superadmin em suporte lê como equipe, mas não abre pedido.
  if not public.app_context_present() or v_bureau is null or v_user is null then
    return query select false, 'not_allowed'::text, null::uuid, null::text;
    return;
  end if;
  if v_role = 'client' then
    v_mode := 'online';
  elsif v_role in ('bureau_admin', 'operator') and public.app_is_staff() then
    v_mode := 'counter';
  else
    return query select false, 'not_allowed'::text, null::uuid, null::text;
    return;
  end if;

  -- 2) Entrada. Sócios só no Dossiê Empresarial, no balcão e no online. Cliente: sem comprador. Equipe: sem pesquisa
  -- própria.
  if p_product_code is null or jsonb_typeof(v_partners) <> 'array'
     or (v_email is not null and (length(v_email) > 254 or v_email !~ c_email_re))
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$') then
    return query select false, 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;
  if v_mode = 'online' then
    if p_product_code not in ('dossie_pf', 'dossie_empresarial') or p_buyer_profile_id is not null then
      return query select false, 'invalid_input'::text, null::uuid, null::text;
      return;
    end if;
    v_buyer := v_user;
  else
    if v_self then
      return query select false, 'invalid_input'::text, null::uuid, null::text;
      return;
    end if;
    v_buyer := p_buyer_profile_id;
  end if;

  if jsonb_array_length(v_partners) > 0 and p_product_code <> 'dossie_empresarial' then
    return query select false, 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  if v_buyer is not null then
    select p.email, p.phone_e164, p.phone_verified_at into v_buyer_p
      from public.profiles p
     where p.id = v_buyer and p.role = 'client' and p.is_active and p.bureau_id = v_bureau;
    if not found then
      return query select false, 'buyer_not_found'::text, null::uuid, null::text;
      return;
    end if;
  end if;

  if v_mode = 'online' then
    -- Sem o lock, pedidos paralelos do mesmo cliente passam todos pela contagem (cada um só vê o que já foi confirmado).
    perform pg_advisory_xact_lock(hashtextextended('online_order_cap:' || v_user::text, 0));
    select count(*) into v_orders_today from public.dossier_orders o
     where o.client_profile_id = v_user and o.mode = 'online' and o.created_at > now() - interval '24 hours';
    if v_orders_today >= c_max_online_orders_per_day then
      return query select false, 'too_many_orders'::text, null::uuid, null::text;
      return;
    end if;
  end if;

  -- Pesquisa própria (online): o Titular mais antigo do cliente; o mesmo documento digitado como terceiro também vale.
  if v_mode = 'online' then
    if v_self then
      select h.id, h.type::text as type, h.document_digits, h.name into v_own
        from public.holders h
       where h.bureau_id = v_bureau and h.client_profile_id = v_user
       order by h.created_at, h.id limit 1;
      if not found then
        return query select false, 'self_holder_missing'::text, null::uuid, null::text;
        return;
      end if;
    elsif v_digits <> '' then
      select h.id, h.type::text as type, h.document_digits, h.name into v_own
        from public.holders h
       where h.bureau_id = v_bureau and h.client_profile_id = v_user and h.document_digits = v_digits
       order by h.created_at, h.id limit 1;
      v_self := found;
    end if;
  end if;
  -- Balcão com comprador: o documento do Titular casa com um Titular da conta dele. É a pesquisa própria do comprador:
  -- o servidor usa o e-mail da conta e o celular confirmado, e o contato digitado é descartado (sem D12).
  if v_mode = 'counter' and v_buyer is not null and v_digits <> '' then
    select h.id, h.type::text as type, h.document_digits, h.name into v_own
      from public.holders h
     where h.bureau_id = v_bureau and h.client_profile_id = v_buyer and h.document_digits = v_digits
     order by h.created_at, h.id limit 1;
    v_subject_is_buyer := found;
  end if;
  v_subject_is_buyer := v_subject_is_buyer or v_self;
  -- Dossiê Pessoa Física no portal é do próprio cliente. Só a conta de Titular PJ pesquisa outra pessoa (o responsável).
  if v_mode = 'online' and p_product_code = 'dossie_pf' and not v_self then
    select h.type::text into v_acct_type
      from public.holders h
     where h.bureau_id = v_bureau and h.client_profile_id = v_user
     order by h.created_at, h.id limit 1;
    if v_acct_type is distinct from 'PJ' then
      return query select false, 'third_party_not_allowed'::text, null::uuid, null::text;
      return;
    end if;
  end if;
  if v_subject_is_buyer then
    v_digits := v_own.document_digits;
    v_name := left(btrim(v_own.name), 200);
  elsif p_subject_type is null or p_subject_type not in ('PF', 'PJ') or length(v_digits) not in (11, 14)
        or v_name = '' or length(v_name) > 200 then
    return query select false, 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  -- 3) Produto à venda no Bureau: produto ativo, item ativo, preço e preço por sócio >= custo efetivo.
  select p.id, i.sale_price, t.product_version_id, v.deps_product into v_main
    from public.products p
    join public.bureau_catalog_items i on i.bureau_id = v_bureau and i.product_id = p.id and i.active
    cross join lateral public.resolve_product_terms(v_bureau, p.id) t
    join public.product_versions v on v.id = t.product_version_id
   where p.code = p_product_code and p.active
     and t.effective_cost is not null and i.sale_price >= t.effective_cost
     and i.sale_price_per_partner >= t.effective_cost_per_partner;
  if not found or v_main.deps_product is null then
    return query select false, 'product_not_for_sale'::text, null::uuid, null::text;
    return;
  end if;

  -- 4) Tipo: dossie_pf é de Titular PF (11 dígitos); dossie_empresarial, de Titular PJ (14 dígitos).
  v_type := case when p_product_code = 'dossie_pf' then 'PF' else 'PJ' end;
  -- v_own só existe na pesquisa própria: o plpgsql não garante curto-circuito, então o ramo é um if.
  if v_subject_is_buyer then
    v_kind_bad := v_own.type <> v_type;
  else
    v_kind_bad := p_subject_type <> v_type or length(v_digits) <> case v_type when 'PF' then 11 else 14 end;
  end if;
  if v_kind_bad then
    return query select false, 'kind_mismatch'::text, null::uuid, null::text;
    return;
  end if;

  -- 6) Contato do Titular principal. Própria: e-mail da conta e celular só se confirmado. Terceiro (cliente): e-mail
  -- obrigatório. Em qualquer canal com comprador, o contato não pode ser o dele (D12). Equipe: o contato só é cobrado de
  -- quem não tem autorização utilizável (abaixo).
  if v_subject_is_buyer then
    v_email := lower(v_buyer_p.email);
    v_phone := case when v_buyer_p.phone_verified_at is not null then v_buyer_p.phone_e164 end;
  else
    if v_mode = 'online' and v_email is null then
      return query select false, 'invalid_input'::text, null::uuid, null::text;
      return;
    end if;
    -- v_buyer_p só existe com comprador: o plpgsql não garante curto-circuito, então o ramo é um if.
    if v_buyer is not null then
      -- Exceção (decisão do dono, risco aceito): no Dossiê Empresarial online, o e-mail do comprador também vale para o
      -- responsável da empresa quando o documento do Titular da conta dele está entre os sócios. O celular nunca vale.
      v_buyer_as_company_contact := v_mode = 'online' and p_product_code = 'dossie_empresarial'
        and v_email = lower(v_buyer_p.email)
        and exists (
          select 1 from jsonb_array_elements(v_partners) e
            join public.holders h on h.bureau_id = v_bureau and h.client_profile_id = v_user
                                 and h.document_digits = regexp_replace(coalesce(e ->> 'document', ''), '\D', '', 'g'));
      if (v_email = lower(v_buyer_p.email) and not v_buyer_as_company_contact)
         or (v_phone is not null and v_phone = v_buyer_p.phone_e164) then
        return query select false, 'contact_is_buyer'::text, null::uuid, null::text;
        return;
      end if;
    end if;
  end if;

  -- Sócios (Dossiê Empresarial): validados antes de qualquer escrita. Sócio repetido conta uma vez.
  v_members := jsonb_build_array(jsonb_build_object('digits', v_digits, 'name', v_name, 'type', v_type,
    'email', v_email, 'phone', v_phone, 'deps', v_main.deps_product));
  if jsonb_array_length(v_partners) > 0 then
    -- O sócio usa o produto DEPS do Dossiê Pessoa Física (Smart PF 002), mesmo que ele não esteja à venda.
    select v.deps_product into v_deps_pf
      from public.products p
      cross join lateral public.resolve_product_terms(v_bureau, p.id) t
      join public.product_versions v on v.id = t.product_version_id
     where p.code = 'dossie_pf';
    if v_deps_pf is null then
      return query select false, 'product_not_for_sale'::text, null::uuid, null::text;
      return;
    end if;
    v_seen := array[v_digits];
    for v_partner in select e from jsonb_array_elements(v_partners) e loop
      v_pdigits := regexp_replace(coalesce(v_partner ->> 'document', ''), '\D', '', 'g');
      v_pname := btrim(coalesce(v_partner ->> 'name', ''));
      v_pemail := nullif(lower(btrim(coalesce(v_partner ->> 'email', ''))), '');
      v_prole := nullif(btrim(coalesce(v_partner ->> 'role', '')), '');
      v_ppct := null;
      -- D9: um consentimento por membro. O sócio precisa do próprio e-mail; o contato da empresa nunca vale por ele.
      if jsonb_typeof(v_partner) <> 'object' or length(v_pdigits) <> 11 or v_pdigits = v_digits
         or v_pname = '' or length(v_pname) > 200
         or v_pemail is null or length(v_pemail) > 254 or v_pemail !~ c_email_re
         or (v_prole is not null and length(v_prole) > 100)
         or (v_partner -> 'percentage' is not null and jsonb_typeof(v_partner -> 'percentage') not in ('number', 'null')) then
        return query select false, 'invalid_input'::text, null::uuid, null::text;
        return;
      end if;
      if jsonb_typeof(v_partner -> 'percentage') = 'number' then
        v_ppct := (v_partner ->> 'percentage')::numeric;
        if v_ppct < 0 or v_ppct > 100 then
          return query select false, 'invalid_input'::text, null::uuid, null::text;
          return;
        end if;
      end if;
      -- D12: o sócio pode ter o e-mail do comprador só se o documento dele for o de um Titular da conta do comprador
      -- (portal ou balcão). Para qualquer outro sócio, nunca.
      if v_buyer is not null then
        select exists (
          select 1 from public.holders h
           where h.bureau_id = v_bureau and h.client_profile_id = v_buyer and h.document_digits = v_pdigits)
          into v_partner_is_buyer;
        if v_pemail = lower(v_buyer_p.email) and not v_partner_is_buyer then
          return query select false, 'contact_is_buyer'::text, null::uuid, null::text;
          return;
        end if;
        if v_partner_is_buyer then
          v_self_member := true;
        end if;
      end if;
      if v_pdigits = any (v_seen) then
        continue;
      end if;
      v_seen := v_seen || v_pdigits;
      v_members := v_members || jsonb_build_array(jsonb_build_object(
        'digits', v_pdigits, 'name', v_pname, 'type', 'PF',
        'email', v_pemail, 'phone', null,
        'deps', v_deps_pf,
        'percentage', v_ppct, 'role', v_prole));
    end loop;
  end if;

  begin
    -- 5) Titular principal: o próprio, o que já existe (sem tocar nele) ou um novo, criado só com nome e documento.
    if v_subject_is_buyer then
      v_holder := v_own.id;
    else
      perform pg_advisory_xact_lock(hashtextextended('holder_document:' || v_bureau::text || ':' || v_digits, 0));
      select h.id into v_holder from public.holders h where h.bureau_id = v_bureau and h.document_digits = v_digits;
      if v_holder is null then
        insert into public.holders (bureau_id, type, name, document, created_by)
        values (v_bureau, v_type::public.query_type, v_name, v_digits, v_user)
        on conflict (bureau_id, document_digits) do nothing
        returning id into v_holder;
        if v_holder is null then
          select h.id into v_holder from public.holders h where h.bureau_id = v_bureau and h.document_digits = v_digits;
        end if;
      end if;
    end if;

    -- 7) Dossiê. O produto DEPS vem da versão vigente do produto principal (D25).
    insert into public.dossiers (bureau_id, kind, holder_id, product, status, created_by)
    values (v_bureau,
            case p_product_code when 'dossie_pf' then 'PF' else 'PJ_FULL' end::public.dossier_kind,
            v_holder, v_main.deps_product, 'pending', v_user)
    returning id into v_dossier;

    -- 8-10) Uma consulta e uma autorização por membro (Titular principal primeiro, depois os sócios).
    for v_i in 0 .. jsonb_array_length(v_members) - 1 loop
      v_member := v_members -> v_i;
      v_mdigits := v_member ->> 'digits';
      v_mname := v_member ->> 'name';
      v_mtype := v_member ->> 'type';
      v_memail := v_member ->> 'email';
      if v_i = 0 then
        v_h := v_holder;
      else
        perform pg_advisory_xact_lock(hashtextextended('holder_document:' || v_bureau::text || ':' || v_mdigits, 0));
        select h.id into v_h from public.holders h where h.bureau_id = v_bureau and h.document_digits = v_mdigits;
        if v_h is null then
          insert into public.holders (bureau_id, type, name, document, created_by)
          values (v_bureau, v_mtype::public.query_type, v_mname, v_mdigits, v_user)
          on conflict (bureau_id, document_digits) do nothing
          returning id into v_h;
          if v_h is null then
            select h.id into v_h from public.holders h where h.bureau_id = v_bureau and h.document_digits = v_mdigits;
          end if;
        end if;
        -- Só o balcão grava o vínculo: os sócios do pedido online vivem nas consultas do pedido, nunca na empresa.
        if v_mode = 'counter' then
          insert into public.holder_partnerships (bureau_id, company_id, partner_id, percentage, role, source, created_by)
          values (v_bureau, v_holder, v_h, (v_member ->> 'percentage')::numeric, v_member ->> 'role', 'operator', v_user)
          on conflict (company_id, partner_id) do nothing;
        end if;
      end if;

      -- Autorização utilizável (ou pedido ainda no prazo) do mesmo Bureau, Titular e comprador (D10).
      v_auth_id := null;
      v_auth_email := null;
      select s.id, s.email into v_auth_id, v_auth_email
        from public.scr_authorizations s
       where s.bureau_id = v_bureau and s.holder_id = v_h and s.client_profile_id is not distinct from v_buyer
         and s.channel = 'internal'
         and ((s.status = 'authorized' and s.expires_at > now())
              or (s.status = 'pending' and (s.request_expires_at is null or s.request_expires_at > now())))
       order by (s.status = 'authorized') desc, s.requested_at desc, s.id
       limit 1;
      if v_auth_id is null and v_memail is null then
        v_fail := 'invalid_input';
        raise exception 'open_order rolled back' using errcode = 'OR001';
      end if;

      insert into public.consultations
        (bureau_id, type, document, document_name, product, holder_id, dossier_id, created_by, status,
         requires_auth, scr_mode, scr_email)
      values (v_bureau, v_mtype::public.query_type, v_mdigits, v_mname, v_member ->> 'deps', v_h, v_dossier, v_user,
              'pending_authorization', true, 'internal', coalesce(v_memail, v_auth_email))
      returning id into v_cid;

      if v_auth_id is null then
        -- Teto de pedidos novos por destinatário (e-mail ou celular) em 24 h: ninguém usa o remetente para spam de um destino.
        -- A pesquisa própria vai para o e-mail da conta do comprador e não conta.
        if not (v_subject_is_buyer and v_i = 0) then
          -- Mesmo motivo do teto por cliente: a contagem é por e-mail e por celular, então o lock é por e-mail e por celular.
          perform pg_advisory_xact_lock(hashtextextended('recipient_cap:' || v_bureau::text || ':' || lower(v_memail), 0));
          if v_member ->> 'phone' is not null then
            perform pg_advisory_xact_lock(hashtextextended('recipient_cap:' || v_bureau::text || ':' || (v_member ->> 'phone'), 0));
          end if;
          select count(*) into v_recent
            from public.scr_authorizations s
           where s.bureau_id = v_bureau and s.status = 'pending' and s.requested_at > now() - interval '24 hours'
             and (lower(s.email) = v_memail
                  or (v_member ->> 'phone' is not null and s.phone_e164 = v_member ->> 'phone'));
          if v_recent >= c_max_recent_requests then
            v_fail := 'too_many_requests';
            raise exception 'open_order rolled back' using errcode = 'OR001';
          end if;
        end if;
        -- O prazo do pedido conta da criação, mesmo que a emissão nunca aconteça; a emissão o renova.
        insert into public.scr_authorizations
          (bureau_id, document, type, name, email, phone_e164, holder_id, client_profile_id, consultation_id,
           requested_by, channel, request_expires_at)
        values (v_bureau, v_mdigits, v_mtype::public.query_type, v_mname, v_memail, v_member ->> 'phone', v_h, v_buyer,
                v_cid, v_user, 'internal', now() + interval '7 days')
        returning id into v_auth_id;
      end if;
      update public.consultations set scr_authorization_id = v_auth_id where id = v_cid;
    end loop;

    -- 11) Pedido. O balcão ainda não tem liquidação: o TypeScript atualiza o estado depois da reserva.
    insert into public.dossier_orders
      (dossier_id, bureau_id, mode, client_profile_id, product_code, self_research, subject_name,
       subject_document_masked, state, created_by)
    values (v_dossier, v_bureau, v_mode, v_buyer, p_product_code, v_self, v_name,
            public.order_mask_document(v_digits),
            case v_mode when 'online' then 'awaiting_authorization' else 'awaiting_payment' end, v_user);
    if v_mode = 'online' then
      perform public.refresh_order_state(v_dossier);
    end if;
    select o.state into v_state from public.dossier_orders o where o.dossier_id = v_dossier;

    -- 12) Trilha: sem documento, nome nem contato.
    insert into public.timeline_events (bureau_id, entity_type, entity_id, event_type, title, metadata, created_by)
    values (v_bureau, 'holder', v_holder, 'order.opened', 'Pedido de pesquisa aberto',
            jsonb_build_object('dossier_id', v_dossier, 'mode', v_mode, 'product_code', p_product_code), v_user);
    insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
    values (v_bureau, v_user, 'order.open', 'dossier_orders', v_dossier,
            jsonb_build_object('mode', v_mode, 'product_code', p_product_code,
                               'members', jsonb_array_length(v_members), 'self_member', v_subject_is_buyer or v_self_member)
                            || case when v_buyer_as_company_contact then jsonb_build_object('buyer_as_company_contact', true)
                                    else '{}'::jsonb end);
  exception when sqlstate 'OR001' then
    return query select false, v_fail, null::uuid, null::text;
    return;
  end;

  -- 13)
  return query select true, null::text, v_dossier, v_state;
end
$$;

-- Troca do contato do pedido de autorização (membro do pedido). Só equipe, só pedido do próprio Bureau que ainda espera
-- pagamento ou autorização, e só autorização pendente e dentro do prazo. Contato nulo = mantém o atual. Titular do
-- comprador: e-mail da conta e celular confirmado, contato digitado descartado. Terceiro: D12 só para contato que muda e
-- teto de pedidos novos por destinatário.
-- Reenvio sem mudança vale só em awaiting_authorization. Em awaiting_payment a troca grava o contato e gira o token, mas
-- não envia: a emissão é do tick depois do pagamento.
-- Limites por autorização, sempre: 2 minutos desde a última troca ou reenvio e 5 trocas ou reenvios em 24 h
-- (contact_changes_at guarda só os instantes das últimas 24 h; o intervalo vale mesmo sem envio feito).
-- Auditoria na mesma transação: um evento por Dossiê afetado (a autorização é compartilhada por Titular e comprador, D10)
-- e um evento sem contato para a recusa D12.
alter table scr_authorizations add column if not exists contact_changes_at timestamptz[] not null default '{}';

drop function if exists update_order_contact(uuid, uuid, text, text);
create function update_order_contact(
  p_dossier_id uuid,
  p_consultation_id uuid,
  p_email text,
  p_phone text
)
returns table (ok boolean, reason text, authorization_id uuid, order_state text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  c_email_re constant text := '^[^\s@,;()<>"]+@[^\s@,;()<>"]+\.[^\s@,;()<>"]+$';
  c_max_recent_requests constant integer := 3;
  -- Intervalo entre trocas ou reenvios da mesma autorização e teto em 24 h.
  c_resend_cooldown constant interval := interval '2 minutes';
  c_max_changes_per_day constant integer := 5;
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_role text := public.app_user_role();
  v_typed_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_typed_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text;
  v_phone text;
  v_order record;
  v_member record;
  v_buyer_p record;
  v_is_buyer boolean := false;
  v_email_changed boolean;
  v_phone_changed boolean;
  v_resend_only boolean;
  v_buyer_override boolean := false;
  v_recent integer;
  v_changes timestamptz[];
  v_other uuid;
begin
  if not public.app_context_present() or v_bureau is null or v_user is null
     or v_role not in ('bureau_admin', 'operator') or not public.app_is_staff() then
    return query select false, 'not_allowed'::text, null::uuid, null::text;
    return;
  end if;
  if p_dossier_id is null or p_consultation_id is null
     or (v_typed_email is not null and (length(v_typed_email) > 254 or v_typed_email !~ c_email_re))
     or (v_typed_phone is not null and v_typed_phone !~ '^\+[1-9][0-9]{7,14}$') then
    return query select false, 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  -- Mesma ordem de trava do cancelamento: pedido, depois autorização.
  select o.state, o.client_profile_id into v_order
    from public.dossier_orders o
   where o.dossier_id = p_dossier_id and o.bureau_id = v_bureau
     for update;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if v_order.state not in ('awaiting_payment', 'awaiting_authorization') then
    return query select false, 'invalid_state'::text, null::uuid, null::text;
    return;
  end if;

  select c.status::text as consultation_status, s.id as auth_id, s.status::text as auth_status, s.document, s.email,
         s.phone_e164, s.request_expires_at, s.contact_changes_at into v_member
    from public.consultations c
    join public.scr_authorizations s on s.id = c.scr_authorization_id
   where c.id = p_consultation_id and c.dossier_id = p_dossier_id and c.bureau_id = v_bureau
     and s.bureau_id = v_bureau and s.channel = 'internal'
     for update of s;
  if not found then
    return query select false, 'not_found'::text, null::uuid, null::text;
    return;
  end if;
  if v_member.consultation_status <> 'pending_authorization' or v_member.auth_status <> 'pending'
     or (v_member.request_expires_at is not null and v_member.request_expires_at <= now()) then
    return query select false, 'invalid_state'::text, null::uuid, null::text;
    return;
  end if;

  v_changes := array(select t from unnest(v_member.contact_changes_at) t where t > now() - interval '24 hours');
  if exists (select 1 from unnest(v_changes) t where t > now() - c_resend_cooldown) then
    return query select false, 'resend_too_soon'::text, null::uuid, null::text;
    return;
  end if;
  if cardinality(v_changes) >= c_max_changes_per_day then
    return query select false, 'contact_limit_reached'::text, null::uuid, null::text;
    return;
  end if;

  if v_order.client_profile_id is not null then
    select p.email, p.phone_e164, p.phone_verified_at into v_buyer_p
      from public.profiles p
     where p.id = v_order.client_profile_id and p.bureau_id = v_bureau;
    v_is_buyer := exists (
      select 1 from public.holders h
       where h.bureau_id = v_bureau and h.client_profile_id = v_order.client_profile_id
         and h.document_digits = v_member.document);
  end if;

  if v_is_buyer then
    -- Perfil ausente ou com e-mail que não vale: não há contato da conta para usar.
    v_email := lower(v_buyer_p.email);
    if v_email is null or length(v_email) > 254 or v_email !~ c_email_re then
      return query select false, 'invalid_input'::text, null::uuid, null::text;
      return;
    end if;
    v_phone := case when v_buyer_p.phone_verified_at is not null then v_buyer_p.phone_e164 end;
    v_buyer_override := (v_typed_email is not null and v_typed_email <> v_email)
                        or (v_typed_phone is not null and v_typed_phone is distinct from v_phone);
    v_email_changed := v_email is distinct from lower(v_member.email);
    v_phone_changed := v_phone is distinct from v_member.phone_e164;
  else
    v_email := coalesce(v_typed_email, lower(v_member.email));
    v_phone := coalesce(v_typed_phone, v_member.phone_e164);
    if v_email is null then
      return query select false, 'invalid_input'::text, null::uuid, null::text;
      return;
    end if;
    v_email_changed := v_email is distinct from lower(v_member.email);
    v_phone_changed := v_phone is distinct from v_member.phone_e164;
    -- D12 vale para o contato que muda: o que já estava no pedido foi validado na abertura.
    -- v_buyer_p só existe com comprador: o plpgsql não garante curto-circuito, então o ramo é um if.
    if v_order.client_profile_id is not null then
      if (v_email_changed and v_email = lower(v_buyer_p.email))
         or (v_phone_changed and v_phone = v_buyer_p.phone_e164) then
        -- A recusa fica na trilha sem o contato digitado.
        insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
        values (v_bureau, v_user, 'order.update_contact_refused', 'dossier_orders', p_dossier_id,
                jsonb_build_object('consultation_id', p_consultation_id, 'authorization_id', v_member.auth_id,
                                   'reason', 'contact_is_buyer', 'email_changed', v_email_changed,
                                   'phone_changed', v_phone_changed));
        return query select false, 'contact_is_buyer'::text, null::uuid, null::text;
        return;
      end if;
    end if;
    if v_email_changed or v_phone_changed then
      perform pg_advisory_xact_lock(hashtextextended('recipient_cap:' || v_bureau::text || ':' || v_email, 0));
      if v_phone is not null then
        perform pg_advisory_xact_lock(hashtextextended('recipient_cap:' || v_bureau::text || ':' || v_phone, 0));
      end if;
      select count(*) into v_recent
        from public.scr_authorizations s
       where s.bureau_id = v_bureau and s.id <> v_member.auth_id and s.status = 'pending'
         and s.requested_at > now() - interval '24 hours'
         and (lower(s.email) = v_email or (v_phone is not null and s.phone_e164 = v_phone));
      if v_recent >= c_max_recent_requests then
        return query select false, 'too_many_requests'::text, null::uuid, null::text;
        return;
      end if;
    end if;
  end if;

  v_resend_only := not v_email_changed and not v_phone_changed;
  -- Em awaiting_payment nada é enviado, então reenviar sem mudança não faz nada.
  if v_resend_only and v_order.state = 'awaiting_payment' then
    return query select false, 'invalid_state'::text, null::uuid, null::text;
    return;
  end if;

  -- O link antigo deixa de existir: token novo, código apagado e e-mail ainda na fila anulado.
  update public.scr_authorizations
     set email = v_email, phone_e164 = v_phone, public_token = gen_random_uuid(), auth_code = null,
         last_checked_at = now(), contact_changes_at = v_changes || now()
   where id = v_member.auth_id;
  update public.consultations set scr_email = v_email
   where scr_authorization_id = v_member.auth_id and status = 'pending_authorization';
  perform public.supersede_notifications('scr_authorization', 'scr_authorization:' || v_member.auth_id::text);

  -- Um evento por Dossiê afetado. Os outros pedidos que usam a mesma autorização só entram se ainda esperam; os já
  -- autorizados ou concluídos ficam de fora, sem erro.
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  select v_bureau, v_user, 'order.update_contact', 'dossier_orders', d.dossier_id,
         jsonb_build_object(
           'consultation_id', p_consultation_id,
           'authorization_id', v_member.auth_id,
           'previous_email_masked', case when v_member.email is null then null
                                         else public.account_mask_recipient('email', lower(v_member.email)) end,
           'email_masked', public.account_mask_recipient('email', v_email),
           'phone_set', v_phone is not null,
           'resend_only', v_resend_only,
           'buyer_override', v_buyer_override)
         || case when d.dossier_id <> p_dossier_id then jsonb_build_object('shared_from_dossier_id', p_dossier_id)
                 else '{}'::jsonb end
    from (
      select p_dossier_id as dossier_id
      union
      select c.dossier_id
        from public.consultations c
        join public.dossier_orders o on o.dossier_id = c.dossier_id and o.bureau_id = v_bureau
       where c.bureau_id = v_bureau and c.scr_authorization_id = v_member.auth_id
         and c.status = 'pending_authorization' and o.state in ('awaiting_payment', 'awaiting_authorization')
    ) d;

  return query select true, null::text, v_member.auth_id, v_order.state;
end
$$;

alter function update_order_contact(uuid, uuid, text, text) owner to auth_profile_lookup;
revoke all on function update_order_contact(uuid, uuid, text, text) from public;
grant execute on function update_order_contact(uuid, uuid, text, text) to app_runtime;

grant select (id, bureau_id, dossier_id, scr_authorization_id, status) on public.consultations to auth_profile_lookup;
grant update (scr_email) on public.consultations to auth_profile_lookup;
grant update (email, phone_e164, public_token, contact_changes_at) on public.scr_authorizations to auth_profile_lookup;
grant select (contact_changes_at) on public.scr_authorizations to auth_profile_lookup;

-- Auditoria de update_order_contact: só estas ações, só do pedido do mesmo Bureau e do autor da sessão.
drop policy if exists audit_logs_order_contact_insert on audit_logs;
create policy audit_logs_order_contact_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('order.update_contact', 'order.update_contact_refused') and table_name = 'dossier_orders'
  and support_session_id is null
  and bureau_id = app_bureau_id() and user_id = app_user_id()
  and exists (
    select 1 from dossier_orders o
     where o.dossier_id = audit_logs.record_id and o.bureau_id = audit_logs.bureau_id)
);
