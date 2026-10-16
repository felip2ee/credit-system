# M6 — Pesquisa e entrega Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute com `superpowers:subagent-driven-development` em **ondas paralelas** (`Files:` / `Depends-on:`, regra `.claude/rules/08-parallel-subagent-driven-development.md`). Os implementadores **não fazem commit**: deixam as mudanças na árvore e reportam `Files changed`. O controlador faz um commit por task, na ordem do plano. Sem reviewer por task. Steps usam checkbox (`- [ ]`).

**Goal:** O cliente compra uma pesquisa no portal (própria ou de terceiro) com reserva de saldo. O titular autoriza a consulta SCR por e-mail ou WhatsApp, e a autorização vale para pedidos futuros enquanto for válida. O operador atende no balcão: cadastra, registra o pagamento, envia a autorização, executa e libera. O cliente recebe aviso, vê o relatório, o parecer IA e o PDF só das entregas liberadas.

**Architecture:** Uma migration nova, `022_orders_delivery.sql`: a tabela `dossier_orders` (1:1 com `dossiers`) com a máquina de estados num trigger, um perfil de sistema por Bureau, colunas novas em `scr_authorizations` e `consultations`, a função `open_order` (`SECURITY DEFINER`, única porta de criação de Dossiê), `refresh_order_state` (estado por pagamento e autorização), `reserve_order` refeita (posse pelo pedido), `confirm_public_scr_authorization` refeita (prazo), `due_order_bureaus`, políticas RLS do cliente e três templates. Camadas: página → Server Action (`src/actions/orders.ts`, `src/actions/orders-client.ts`) → `src/lib/orders/*` → SQL. O trabalho assíncrono (pedido SCR, expiração, execução DEPS, parecer IA, liberação online) roda num tick (`POST /api/internal/orders/tick`) chamado pelo cron do M4, com a identidade do perfil de sistema do Bureau e a RLS de equipe.

**Tech Stack:** Next.js 14.2, React 18, PostgreSQL 18 (RLS), node-postgres, zod 3, Vitest 4, `@react-pdf/renderer` (já instalado), shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-15-m6-pesquisa-e-entrega-design.md`. Issues: #42, #43, #44, #45, #46, #65 (e #27, #34, #36). Branch: crie `feature/m6-pesquisa-e-entrega` a partir de `feature/m5-contas-de-cliente` (migrations 001–021), ou de `main` depois do merge do M5. **Aprovação:** as decisões da seção "Decisões a confirmar" da spec precisam do "sim" do usuário antes da onda 1. Uma resposta diferente muda as tasks indicadas na tabela da spec.

## Global Constraints

- Crie só `db/migrations/022_orders_delivery.sql` (Task 1). Não edite as migrations 001–021. Recrie o banco de dev antes dos testes de integração: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Testes de integração (`*.integration.test.ts`) rodam contra `127.0.0.1:54329`. Use `seedTenant`, `seedClientProfile`, `seedProduct`, `seedProductVersion`, `seedBureauCost`, `seedCatalogItem`, `seedWalletTopup`, `seedClientWalletTopup`, `withDbContext`, `randomCpf` de `src/test/seed.ts`. Só a Task 1 edita `src/test/seed.ts`.
- Todo arquivo de teste que cria notificação chama `acquireClaimLock` no `beforeAll` e `releaseClaimLock` no `afterAll` (`src/lib/notifications/claim-lock.test-util.ts`).
- Funções `SECURITY DEFINER` seguem a 009, a 020 e a 021: `set search_path = pg_catalog, public`, nomes qualificados com `public.`, `alter function ... owner to auth_profile_lookup`, `revoke all ... from public`, `grant execute` só para `app_runtime` e só nas funções públicas, políticas `*_gateway` `to auth_profile_lookup` e grants por coluna só no que a função escreve.
- **Dinheiro:** `numeric(15,2)` no SQL; string decimal na borda e centavos inteiros no TypeScript (`toCents`, `fromCents` de `src/lib/catalog/money.ts`). Nunca `number` de ponto flutuante para valor. Nenhuma regra de saldo fora de `reserve_order`, `capture_order` e `release_order`: o TypeScript chama `reserveOrder`, `captureOrder` e `releaseOrder` (`src/lib/settlement/queries.ts`).
- **Mesma transação:** abrir pedido + reservar; concluir + capturar; falhar ou cancelar + liberar; liberar entrega + enfileirar aviso; cada mutação + auditoria (`writeAuditEvent`) + evento de timeline (`recordHolderEvent`) quando houver Titular.
- Nunca grave nem logue CPF/CNPJ completo, e-mail sem máscara, telefone sem máscara, código SCR ou token em auditoria, log ou erro. Log da aplicação: só o passo, o nome e o código do erro (modelo de `logFailure` em `src/actions/counter-payments.ts`).
- **Arquivo `"use server"` nunca exporta função que recebe `DbIdentity`.** Toda função chamada pelo tick (identidade de sistema) fica em `src/lib/`, sem `"use server"`. Uma exportação em arquivo de ação vira endpoint público.
- Server Actions: zod `safeParse` → sessão, papel e permissão → query → `revalidatePath`; retorno `{ error: string | null, id? }`. Queries retornam `{ ok: false, reason }` para conflito de negócio; motivo fora da lista lança `Error("unexpected <função> reason")`.
- A chamada DEPS nunca roda dentro de uma transação aberta: claim (transação curta) → DEPS → `executeConsultation` (transação própria) → transição (transação curta).
- Identificadores em inglês. UI, erros e comentários em pt-BR.
- **Gate da task:** os testes do escopo da task passam. `npm run lint && npm run type-check && npm run test` passam no fim da onda 5. Entre a onda 4 e a onda 5 o `type-check` falha nos componentes que importam ações removidas pela Task 5 (risco aceito, como no M1).
- Implementadores: agente especialista com `model: "sonnet"`; a Task 8 com `model: "haiku"`. Nunca `opus`.
- Commits: um por task, Conventional Commits, `Closes #n` no corpo quando a task fecha a issue, linha final `Co-Authored-By` conforme o lembrete da sessão. Rode `git rev-parse --short HEAD` antes e registre o hash. `git add` só dos `Files:` da task.

## Decisões deste plano que completam a spec

1. **Uma função de abertura para os dois canais.** `open_order` decide o modo pelo papel do chamador (`client` → online; equipe → balcão). A equipe não ganha INSERT em `dossier_orders`; o cliente não ganha INSERT em `holders`, `dossiers` nem `consultations`. Duas portas de criação duplicariam a regra de Titular, produto e autorização.
2. **Estado calculado num só lugar.** `refresh_order_state` (invoker) é a única regra de `awaiting_payment | awaiting_authorization | ready`. `open_order`, o pagamento de balcão (registrar e anular) e o tick a chamam. O TypeScript não decide esses três estados.
3. **Transições pós-execução no TypeScript, com guard no SQL.** `executing → ready | completed | failed`, `completed ↔ released` e `→ cancelled` são `update` com a RLS de equipe. O trigger `dossier_orders_guard` recusa qualquer outra transição e qualquer mudança de coluna imutável.
4. **Ligação consulta ↔ autorização.** `consultations.scr_authorization_id` aponta para a linha SCR que vale para aquele membro. Uma autorização reaproveitada liga a consulta nova à linha antiga, sem copiar.
5. **O tick emite o pedido SCR.** `open_order` só cria a linha `pending` (sem código). O tick, com a identidade de sistema, monta o termo (`buildScrConsentTerm`) e chama `issueSelfScrAuthorization`. O cliente não lê `settings` e `enqueue_notification` recusa o papel `client`; assim o M6 não precisa de nova função de notificação sem staff.
6. **Prazo do pedido gravado na emissão.** `issueSelfScrAuthorization` grava `request_expires_at = now() + interval '7 days'`. Linha sem código tem `request_expires_at` nulo e não expira.

## Review Focus

1. Dinheiro — Task 4: `online order end to end debits P from the client and accrues P minus C`; Task 3: `insufficient balance leaves no dossier, order or scr row`, `clawed back capture fails the order without delivery`, `cancel and fail release the reservation exactly once`.
2. Execução única — Task 3: `two concurrent claims return disjoint orders`, `expired lease is claimed again`; Task 4: `retry after lease uses reuseExisting`.
3. RLS do cliente — Task 1: `client reads delivery only while released`, `client reads zero third party holders, payloads, scr rows and costs`, `nobody inserts dossier_orders outside open_order`.
4. Consentimento — Task 1: `same buyer reuses a valid authorization`, `another buyer gets a new request`, `expired request answers expired`, `contact equal to the buyer is refused`; Task 2: `scr code uses randomInt`, `self registered holder email is never the default`.
5. Perfil de sistema — Task 1: `system profile has no account and no session lookup`, `app_runtime cannot change is_system`.
6. Máquina de estados — Task 1: `guard refuses transitions outside the table and immutable column changes`.
7. Superfície pública — Task 4: `tick route refuses a wrong secret`; Task 5: `client pdf route returns 404 for another client or an unreleased order`; Global Constraint "use server".
8. Ponte com o M2 — Task 2: `real client resolves the product id by options.product`; Task 1: `open_order writes deps_product of the current version`.

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `db/migrations/022_orders_delivery.sql` | tabela, guard, perfil de sistema, colunas, funções, RLS, grants, templates | 1 |
| `src/lib/orders/orders.integration.test.ts` | regras das funções SQL | 1 |
| `src/lib/db/rls.integration.test.ts` | casos de RLS e grant da 022 | 1 |
| `src/test/seed.ts` | `seedOrderDossier*` gravam o pedido | 1 |
| `src/lib/deps/{client,real}.ts` (+ testes), `src/types/deps.ts`, `scripts/setup/{setup_production,test_setup_production}.py`, `.env.example` | produto DEPS por nome | 2 |
| `src/lib/scr/queries.ts` (+ testes), `src/actions/scr-self.ts` (+ teste), `src/components/scr/scr-self-authorize-form.tsx` | pedido SCR por WhatsApp, prazo, código, `expired` | 2 |
| `src/lib/orders/{types,labels,queries,client-queries}.ts` (+ testes) | pedido: abrir, estado, claim, transições, leituras | 3 |
| `src/lib/validators/order.ts` (+ teste) | schemas do pedido | 3 |
| `src/lib/counter-payments/queries.ts` (+ teste) | pagamento chama `refreshOrderState` | 3 |
| `src/lib/orders/{execute,ai,tick}.ts` (+ testes), `src/lib/settings/readers.ts`, `src/actions/settings.ts`, `src/actions/ai.ts`, `src/lib/ai/persist.ts` | execução, parecer IA, tick | 4 |
| `src/app/api/internal/orders/tick/route.ts` (+ teste), `scripts/notifications-cron.mjs` (+ teste), `docker-stack.yml` | rota e cron do tick | 4 |
| `src/actions/{orders,orders-client}.ts` (+ testes), `src/app/(portal)/portal/pesquisas/[id]/pdf/route.ts` (+ teste) | ações e PDF do cliente | 5 |
| `src/actions/{consultations,dossiers,scr}.ts` (+ testes), `src/lib/dossiers/queries.ts` | remoção das ações que chamam a DEPS; estado do pedido na lista | 5 |
| `src/components/dossiers/*`, `src/components/consultations/*`, `src/app/(dashboard)/{dossiers,consultations,settings/users}/**`, `src/lib/deps/products.ts` (+ teste) | telas do balcão e da equipe; sai `depsProductName` | 6 |
| `src/app/(portal)/layout.tsx`, `src/app/(portal)/portal/page.tsx`, `src/app/(portal)/portal/pesquisas/**/page.tsx`, `src/components/orders/*` | telas do portal | 7 |
| `docs/architecture.md`, `PRODUCT.md`, `docs/operations/notifications.md`, `docs/operations/orders.md` | documentação do M6 | 8 |

**Arquivos compartilhados e dono único:** `src/test/seed.ts` → Task 1. `src/lib/orders/queries.ts` e `client-queries.ts` → Task 3 (as Tasks 4, 5, 6, 7 só importam). `src/lib/scr/queries.ts` → Task 2. `src/lib/deps/products.ts` → Task 6. `src/lib/dossiers/queries.ts` → Task 5. `src/lib/db/permissions.ts` e `src/middleware.ts`: nenhuma task edita (sem permissão nova; `/api/internal/` já é público no middleware — a Task 4 confere e, se não for, inclui o arquivo e o teste do middleware).

## Ondas

| Onda | Tasks | Por quê |
|---|---|---|
| 1 | 1 | schema e funções; contratos fixados neste plano |
| 2 | 2, 3, 8 | usam a 022; arquivos disjuntos |
| 3 | 4 | usa o produto DEPS e o pedido SCR (2) e as transições (3) |
| 4 | 5 | usa a execução (4) e as queries (3) |
| 5 | 6, 7 | usam as ações (5); arquivos disjuntos |

Review uma vez, no fim, sobre o diff inteiro: `code-reviewer` e `security-reviewer` (dinheiro, consentimento, RLS do cliente, perfil de sistema, rota do tick). Um review final em `opus` é permitido por tocar dinheiro e segurança; nunca como implementador.

---

### Task 1: Migration 022 — pedido, autorização e entrega

**Agent:** `database-architect` · `model: "sonnet"`
**Files:**
- Create: `db/migrations/022_orders_delivery.sql`
- Create: `src/lib/orders/orders.integration.test.ts`
- Modify: `src/lib/db/rls.integration.test.ts` (novo `describe("orders and delivery (022)")` no fim)
- Modify: `src/test/seed.ts` (`seedOrderDossier`, `seedOrderDossierForSession`)
- Modify: testes existentes que contam perfis do Bureau e quebram pelo perfil de sistema (só a contagem; liste-os no relatório)

**Depends-on:** none

**Interfaces:**
- Produces (EXECUTE para `app_runtime`):
  - `open_order(p_product_code text, p_with_ai boolean, p_self boolean, p_subject_type text, p_subject_name text, p_subject_document text, p_partners jsonb, p_contact_email text, p_contact_phone text, p_buyer_profile_id uuid) returns table (ok boolean, reason text, dossier_id uuid, state text)` — reasons `not_allowed | invalid_input | product_not_for_sale | addon_not_for_sale | kind_mismatch | self_holder_missing | contact_is_buyer | buyer_not_found`.
  - `refresh_order_state(p_dossier_id uuid) returns text` (invoker; devolve o estado ou nulo).
  - `due_order_bureaus() returns table (bureau_id uuid, system_profile_id uuid)` (definer; só ids).
  - `reserve_order(...)` e `confirm_public_scr_authorization(...)` com a mesma assinatura de antes.
- Produces (internas, sem grant): `create_bureau_system_profile()` (trigger), `order_mask_document(text) returns text`.
- Consumes: `resolve_product_terms` (010), `order_settlements`, `counter_payments` (015), `reserve_order` (018), `confirm_public_scr_authorization` (009), `auth_profile_for_session` (versão mais nova: procure o último `create or replace function auth_profile_for_session` nas migrations), `notification_templates` (020), `append_only_guard()`.

**Schema (forma exata):**

```sql
-- M6: pesquisa e entrega. A 001-021 já foram aplicadas e não mudam.
-- dossier_orders: um pedido por Dossiê; estado protegido por dossier_orders_guard.
-- open_order é a única porta de criação de Dossiê (cliente = online, equipe = balcão).
-- Perfil de sistema por Bureau: identidade do tick, sem account e sem sessão.

alter table profiles add column is_system boolean not null default false;
alter table profiles add constraint profiles_system_operator check (not is_system or role = 'operator');
create unique index profiles_system_bureau_idx on profiles (bureau_id) where is_system;

alter table scr_authorizations
  add column client_profile_id uuid,
  add column phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column request_expires_at timestamptz,
  add constraint scr_authorizations_buyer_fk foreign key (bureau_id, client_profile_id) references profiles (bureau_id, id);
create index scr_authorizations_scope_idx on scr_authorizations (bureau_id, holder_id, client_profile_id, status);
create index scr_authorizations_pending_expiry_idx on scr_authorizations (request_expires_at) where status = 'pending';

alter table consultations add column scr_authorization_id uuid references scr_authorizations (id);

create table dossier_orders (
  dossier_id uuid primary key,
  bureau_id uuid not null references bureaus (id),
  mode text not null check (mode in ('online', 'counter')),
  client_profile_id uuid,
  product_code text not null check (product_code in ('consulta_pf', 'consulta_pj', 'dossie_pj_completo')),
  with_ai boolean not null default false,
  self_research boolean not null default false,
  subject_name text not null check (btrim(subject_name) <> '' and length(subject_name) <= 200),
  subject_document_masked text not null,
  state text not null check (state in ('awaiting_payment', 'awaiting_authorization', 'ready', 'executing',
    'completed', 'released', 'failed', 'cancelled')),
  state_reason text check (state_reason is null or state_reason in ('scr_refused', 'scr_expired', 'payment_timeout',
    'cancelled_by_staff', 'deps_no_data', 'deps_incompatible', 'deps_unavailable', 'reservation_clawed_back')),
  ai_status text not null default 'none' check (ai_status in ('none', 'pending', 'done', 'failed')),
  ai_attempts integer not null default 0 check (ai_attempts between 0 and 10),
  attempts integer not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  released_at timestamptz,
  released_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text check (revoke_reason is null or (btrim(revoke_reason) <> '' and length(revoke_reason) <= 500)),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dossier_orders_online_buyer check (mode <> 'online' or client_profile_id is not null),
  constraint dossier_orders_self_online check (not self_research or mode = 'online'),
  constraint dossier_orders_full_counter check (product_code <> 'dossie_pj_completo' or mode = 'counter'),
  constraint dossier_orders_ai check (with_ai or ai_status = 'none'),
  constraint dossier_orders_released check (state <> 'released' or released_at is not null),
  foreign key (bureau_id, dossier_id) references dossiers (bureau_id, id),
  foreign key (bureau_id, client_profile_id) references profiles (bureau_id, id),
  foreign key (bureau_id, created_by) references profiles (bureau_id, id),
  foreign key (bureau_id, released_by) references profiles (bureau_id, id),
  foreign key (bureau_id, revoked_by) references profiles (bureau_id, id)
);
create index dossier_orders_due_idx on dossier_orders (bureau_id, state, next_attempt_at);
create index dossier_orders_client_idx on dossier_orders (client_profile_id, created_at desc) where client_profile_id is not null;

-- Só as transições da spec; colunas fora de v_mutable nunca mudam; nada se apaga.
create function dossier_orders_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_mutable constant text[] := array['state', 'state_reason', 'ai_status', 'ai_attempts', 'attempts',
    'next_attempt_at', 'lease_until', 'released_at', 'released_by', 'revoked_at', 'revoked_by',
    'revoke_reason', 'updated_at'];
begin
  if tg_op <> 'UPDATE' then
    raise exception 'dossier_orders allows no delete' using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'dossier_orders immutable column changed' using errcode = 'check_violation';
  end if;
  if old.state = new.state or (old.state, new.state) in (
       ('awaiting_payment', 'awaiting_authorization'), ('awaiting_payment', 'ready'), ('awaiting_payment', 'cancelled'),
       ('awaiting_authorization', 'awaiting_payment'), ('awaiting_authorization', 'ready'),
       ('awaiting_authorization', 'cancelled'),
       ('ready', 'awaiting_payment'), ('ready', 'awaiting_authorization'), ('ready', 'executing'), ('ready', 'cancelled'),
       ('executing', 'ready'), ('executing', 'completed'), ('executing', 'failed'),
       ('completed', 'released'), ('released', 'completed')) then
    return new;
  end if;
  raise exception 'dossier_orders transition % -> % is not allowed', old.state, new.state
    using errcode = 'check_violation';
end
$$;
create trigger dossier_orders_guard before update or delete on dossier_orders
  for each row execute function dossier_orders_guard();
create trigger dossier_orders_no_truncate before truncate on dossier_orders
  for each statement execute function dossier_orders_guard();
```

**Máscara (forma exata, igual à do M5):**

```sql
create function order_mask_document(p_digits text) returns text
language sql immutable set search_path = pg_catalog, public as $$
  select case length(p_digits)
    when 11 then '***.' || substr(p_digits, 4, 3) || '.' || substr(p_digits, 7, 3) || '-**'
    when 14 then '**.' || substr(p_digits, 3, 3) || '.' || substr(p_digits, 6, 3) || '/' || substr(p_digits, 9, 4) || '-**'
  end
$$;
```

**`refresh_order_state` (forma exata — regra de pagamento e de autorização):**

```sql
create function refresh_order_state(p_dossier_id uuid)
returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_o public.dossier_orders;
  v_price numeric;
  v_paid numeric;
  v_paid_ok boolean := true;
  v_auth_ok boolean;
  v_next text;
begin
  select * into v_o from public.dossier_orders where dossier_id = p_dossier_id for update;
  if not found then return null; end if;
  if v_o.state not in ('awaiting_payment', 'awaiting_authorization', 'ready') then return v_o.state; end if;
  if v_o.mode = 'counter' then
    select s.price into v_price from public.order_settlements s where s.order_ref = p_dossier_id;
    select coalesce(sum(p.amount), 0) into v_paid from public.counter_payments p
     where p.dossier_id = p_dossier_id and p.voided_at is null;
    v_paid_ok := v_price is not null and v_paid >= v_price;
  end if;
  select bool_and(s.status = 'authorized' and s.expires_at > now()) into v_auth_ok
    from public.consultations c
    left join public.scr_authorizations s on s.id = c.scr_authorization_id
   where c.dossier_id = p_dossier_id;
  v_next := case when not v_paid_ok then 'awaiting_payment'
                 when coalesce(v_auth_ok, false) then 'ready'
                 else 'awaiting_authorization' end;
  if v_next <> v_o.state then
    update public.dossier_orders set state = v_next, updated_at = now() where dossier_id = p_dossier_id;
  end if;
  return v_next;
end
$$;
```

**`reserve_order` (D27):** `create or replace` com o corpo da 018 **copiado sem mudança**, exceto o bloco `if not exists (select 1 from public.dossiers d ...)`, que passa a ser:

```sql
  if not exists (
    select 1 from public.dossier_orders o
     where o.dossier_id = p_order_ref and o.bureau_id = v_bureau and o.mode = p_mode
       and (p_mode = 'counter' or o.client_profile_id = v_user)
  ) then
    return query select false, 'not_found'::text, null::text;
    return;
  end if;
```

**`confirm_public_scr_authorization` (D11):** `create or replace` com o corpo da 009 sem mudança, mais uma checagem logo depois de `if v_status in ('authorized', 'not_authorized') then return 'already'; end if;`: se `request_expires_at` da linha (leia na mesma `select ... for update`) não é nulo e é `< now()`, faça `update ... set status = 'expired', auth_code = null, last_checked_at = now()`, insira na timeline `scr.expired` ("Pedido de autorização SCR expirado") e devolva `'expired'`. Uma linha que já está `expired` também devolve `'expired'`.

**`open_order` (contrato; o implementador escreve o corpo):** `SECURITY DEFINER`, dono `auth_profile_lookup`, uma transação do chamador. Na ordem:
1. Contexto (`app_context_present()`, `app_bureau_id()` não nulo) e papel `client` ou `app_is_staff()`; senão `not_allowed`. Superadmin em suporte: `not_allowed`. Modo: `client` → `online`; equipe → `counter`.
2. Cliente: produto em (`consulta_pf`, `consulta_pj`), `p_partners` vazio ou nulo, `p_buyer_profile_id` nulo; senão `invalid_input`. Equipe: `p_self` falso; `p_buyer_profile_id` nulo ou perfil `client` ativo do Bureau (senão `buyer_not_found`).
3. Produto à venda no Bureau (produto ativo, item ativo, `sale_price >= effective_cost` de `resolve_product_terms`); senão `product_not_for_sale`. `p_with_ai`: `parecer_ia` à venda com `addon_for @> array[p_product_code]`; senão `addon_not_for_sale`.
4. Tipo: `consulta_pf` → Titular PF (11 dígitos); os outros → PJ (14 dígitos); senão `kind_mismatch`. Dossiê: `PF`, `PJ`, `PJ_FULL`.
5. Titular principal: `p_self` → o Titular mais antigo com `client_profile_id = app_user_id()` (senão `self_holder_missing`); documento igual ao do Titular próprio do cliente também vira pesquisa própria. Outro: busca por (`bureau_id`, `document_digits`); sem linha, `insert ... on conflict (bureau_id, document_digits) do nothing` e nova leitura. **Nunca atualiza um Titular existente.**
6. Contato: própria → e-mail de `profiles.email` do comprador e `phone_e164` só com `phone_verified_at` não nulo. Terceiro (cliente) → `p_contact_email` obrigatório; `lower(p_contact_email) = lower(` e-mail do comprador `)` ou `p_contact_phone = phone_e164` do comprador → `contact_is_buyer`. Equipe → `p_contact_email` obrigatório quando o membro não tem autorização utilizável no escopo (`invalid_input`). Nunca usa `holders.email` (D14).
7. Dossiê: `insert into dossiers (bureau_id, kind, holder_id, product, status, created_by)` com `product` = `deps_product` da versão vigente do produto principal (D25), `status = 'pending'`.
8. PJ completo (só equipe): cada sócio de `p_partners` (`document`, `name`, `email`, `percentage`, `role`) vira Titular (passo 5) e Sociedade (`source = 'operator'`, sem atualizar uma Sociedade existente); sócio repetido conta uma vez; e-mail do sócio ou, sem ele, o contato principal.
9. Consultas: uma por membro, `status = 'pending_authorization'`, `requires_auth = true`, `scr_mode = 'internal'`, `scr_email` = contato do membro, `product` = `deps_product` da versão vigente (sócio PF: de `consulta_pf`).
10. Autorização por membro (escopo = Bureau, Titular, `client_profile_id is not distinct from` comprador): utilizável (`authorized`, `expires_at > now()`) → liga; senão `pending` com `request_expires_at is null or > now()` → liga; senão insere `pending` (`channel = 'internal'`, `document` só dígitos, `type`, `name`, `email`, `phone_e164`, `holder_id`, `client_profile_id`, `consultation_id`, `requested_by = app_user_id()`) e liga. Grava `consultations.scr_authorization_id`.
11. Pedido: insere `dossier_orders` (`state = 'awaiting_authorization'` online, `'awaiting_payment'` balcão; `subject_name`; `subject_document_masked = order_mask_document(...)`; `self_research`; `created_by = app_user_id()`), depois `perform refresh_order_state(dossier)` só no modo online (o balcão ainda não tem liquidação; o TypeScript chama depois da reserva).
12. Timeline do Titular principal `order.opened` ("Pedido de pesquisa aberto"; metadata `dossier_id`, `mode`, `product_code`); auditoria `order.open` (metadata `mode`, `product_code`, `with_ai`, `members`; sem documento, nome nem contato).
13. Devolve `(true, null, dossier_id, state)`.
- Grants da 022 para `auth_profile_lookup`: SELECT em `profiles`, `"user"` (email), `products`, `product_versions`, `bureau_catalog_items`, `holders`, `holder_partnerships`, `scr_authorizations`, `consultations`, `dossier_orders`, `order_settlements`, `counter_payments`; INSERT por coluna em `holders`, `holder_partnerships`, `dossiers`, `consultations`, `scr_authorizations`, `dossier_orders`, `timeline_events`, `audit_logs`; UPDATE (`scr_authorization_id`) em `consultations`, UPDATE (`state`, `updated_at`) em `dossier_orders`, UPDATE (`status`, `auth_code`, `last_checked_at`) em `scr_authorizations`; políticas `*_gateway` correspondentes. EXECUTE em `resolve_product_terms`, `order_mask_document` e `refresh_order_state`.

**Perfil de sistema (D15):**
- Trigger `after insert on bureaus` → `create_bureau_system_profile()` (definer): insere `"user"` (`id` uuid novo, `name = 'Sistema'`, `email = 'sistema+' || new.id || '@sistema.invalid'`, `email_verified = true`) e `profiles` (`id` = mesmo uuid, `auth_user_id`, `full_name = 'Sistema'`, `email`, `role = 'operator'`, `bureau_id`, `is_system = true`). Nenhuma linha em `account`. O trigger de carteira do cliente (015) não age (papel `operator`).
- Backfill no fim da migration para cada Bureau sem perfil de sistema.
- `auth_profile_for_session`: `create or replace` com a versão mais nova copiada, mais `and not p.is_system` no filtro do perfil.
- Trigger `protect_system_profile` (`before update or delete on profiles`): com `current_user = 'app_runtime'`, recusa mudança de `is_system` e qualquer UPDATE ou DELETE de linha com `old.is_system`.

**RLS e grants (forma exata das políticas do cliente):**

```sql
alter table dossier_orders enable row level security;
alter table dossier_orders force row level security;
grant select, update (state, state_reason, ai_status, ai_attempts, attempts, next_attempt_at, lease_until,
  released_at, released_by, revoked_at, revoked_by, revoke_reason, updated_at) on dossier_orders to app_runtime;

create policy dossier_orders_staff_select on dossier_orders for select
  using (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy dossier_orders_staff_update on dossier_orders for update
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy dossier_orders_client_select on dossier_orders for select
  using (app_context_present() and app_user_role() = 'client'
         and bureau_id = app_bureau_id() and client_profile_id = app_user_id());

create policy dossiers_client_released on dossiers for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from dossier_orders o where o.dossier_id = dossiers.id
                      and o.client_profile_id = app_user_id() and o.state = 'released'));
create policy consultations_client_released on consultations for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from dossier_orders o where o.dossier_id = consultations.dossier_id
                      and o.client_profile_id = app_user_id() and o.state = 'released'));
create policy bureau_results_client_released on bureau_results for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from consultations c join dossier_orders o on o.dossier_id = c.dossier_id
                      where c.id = bureau_results.consultation_id
                        and o.client_profile_id = app_user_id() and o.state = 'released'));
create policy ai_reports_client_released on ai_reports for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from consultations c join dossier_orders o on o.dossier_id = c.dossier_id
                      where c.id = ai_reports.consultation_id
                        and o.client_profile_id = app_user_id() and o.state = 'released'));
```

- Sem INSERT nem DELETE de `dossier_orders` para `app_runtime`. Sem política de cliente em `holders` (fica a do M1), `scr_authorizations`, `bureau_payloads`.
- `due_order_bureaus()` (definer): Bureaus ativos com pedido em `awaiting_payment` criado há mais de 7 dias, `awaiting_authorization`, `ready` com `next_attempt_at` vencido ou nulo, `executing` com lease vencida, `completed` com `ai_status = 'pending'` ou (`mode = 'online'` e `ai_status <> 'pending'`), ou com `scr_authorizations` `pending` e `request_expires_at < now()`. Devolve `bureau_id` e o id do perfil de sistema.

**Templates (seed):** `scr_authorization` WhatsApp v1 (`pt_BR`, parâmetros `clientName`, `authorizedName`, `code`, `url`); `research_released` e-mail v1 (assunto "Sua pesquisa está disponível", parâmetros `clientName`, `url`, HTML e texto pt-BR no modelo do `scr_authorization` e-mail) e WhatsApp v1 (`pt_BR`, `clientName`, `url`). Mesma forma de insert da 020 e da 021.

**`src/test/seed.ts`:** `seedOrderDossier` e `seedOrderDossierForSession` passam a inserir também `dossier_orders` (como dono, `on conflict do nothing`): `mode` = `online` com `clientProfileId`, senão `counter`; `client_profile_id`; `product_code = 'consulta_pf'`; `subject_name = 'Titular seed'`; `subject_document_masked = '***.000.000-**'`; `state = 'awaiting_authorization'`; `created_by` = o `created_by` do Titular. Os testes do M3b continuam verdes sem outra mudança.

**Testes (casos mínimos):**
- `orders.integration.test.ts` (`acquireClaimLock`):
  - `client opens an own order in one transaction`: Dossiê, 1 consulta `pending_authorization` com `scr_mode internal` e `product` = `deps_product` da versão vigente, pedido `awaiting_authorization`, linha SCR `pending` com o e-mail da conta e `client_profile_id` do comprador; auditoria `order.open` sem documento.
  - `third party order never updates an existing holder` (nome e e-mail do Titular antigo iguais depois do pedido); contato na linha SCR.
  - `contact equal to the buyer is refused` (e-mail com outra caixa; celular igual).
  - `same buyer reuses a valid authorization` (pedido nasce `ready`); `another buyer gets a new request`; `expired authorization gets a new request`; `pending request in scope is linked, not duplicated`.
  - `client cannot order dossie_pj_completo`; `product not for sale`; `addon without compatible main`; `kind mismatch`; `superadmin in support is not_allowed`.
  - `staff opens a counter order in awaiting_payment`; `buyer of another bureau is buyer_not_found`; PJ completo cria Titulares, Sociedades e uma consulta por sócio.
  - `reserve_order accepts the buyer third party order and refuses another client` (online, `not_found`).
  - `refresh_order_state`: balcão com pagamentos `0.10` + `0.20` contra preço `0.30` → sai de `awaiting_payment`; anulação volta; todas autorizadas → `ready`; uma autorização vencida → `awaiting_authorization`.
  - `guard refuses transitions outside the table and immutable column changes` (`failed → ready`, `released → executing`, mudança de `client_profile_id`, DELETE — dono incluso).
  - `expired request answers expired` (marca `expired`, timeline `scr.expired`); pedido no prazo autoriza como antes.
  - `system profile is created for a new bureau and backfilled`; `system profile has no account and no session lookup` (`auth_profile_for_session` sem linha).
  - `due_order_bureaus lists only bureaus with due work`.
  - Templates novos ativos.
- `rls.integration.test.ts`:
  - `client reads only own dossier_orders`; staff de outro Bureau lê zero.
  - `client reads delivery only while released`: `dossiers`, `consultations`, `bureau_results`, `ai_reports` zero antes, linhas em `released`, zero depois de voltar a `completed`; outro cliente com pedido liberado não lê.
  - `client reads zero third party holders, payloads, scr rows and costs` (`holders`, `bureau_payloads`, `scr_authorizations`, `order_settlement_cost`).
  - `nobody inserts dossier_orders outside open_order` (cliente e equipe recebem erro de permissão); `client cannot update dossier_orders`.
  - `app_runtime cannot change is_system or update the system profile`.
  - `create_bureau_system_profile` e `order_mask_document` sem EXECUTE para `app_runtime`.

- [ ] Escreva os testes (vermelhos).
- [ ] Escreva a migration e rode `npm run db:reset` com a URL do dono.
- [ ] Rode `npx vitest run src/lib/orders/orders.integration.test.ts src/lib/db/rls.integration.test.ts src/lib/settlement` até ficar verde.
- [ ] Rode `npm run test` uma vez (o trigger de Bureau e o seed mudam fixtures de todos). Ajuste só contagens de perfil que quebrarem e liste os arquivos.
- [ ] Entregue: lista de `Files changed`.

---

### Task 2: Produto DEPS por nome e pedido SCR por WhatsApp

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Modify: `src/types/deps.ts` (`ConsultOptions.product` obrigatório)
- Modify: `src/lib/deps/client.ts`, `src/lib/deps/real.ts` (+ testes existentes do cliente real, ou crie `src/lib/deps/real.test.ts`)
- Modify: `scripts/setup/setup_production.py`, `scripts/setup/test_setup_production.py`, `.env.example`
- Modify: `src/lib/scr/queries.ts`, `src/lib/scr/queries.test.ts`, `src/lib/scr/queries.integration.test.ts`
- Modify: `src/actions/scr-self.ts`, `src/actions/scr-self.test.ts`
- Modify: `src/components/scr/scr-self-authorize-form.tsx`

**Depends-on:** 1

**Interfaces:**
- `real.ts` (D25): o login guarda o mapa `nome → identificador` de `produtos`. `consultPF`/`consultPJ` procuram o identificador por `options.product`; nome ausente lança `Error(\`Produto "${nome}" não está disponível para esta conta na deps.\`)`. `DepsRawConsult.product` = `options.product`. `RealClientConfig` perde `produtoPfNome`/`produtoPjNome`; `client.ts` para de ler `DEPS_PRODUTO_PF|PJ`. O setup Python e `.env.example` perdem as duas variáveis. `depsProductName` e as constantes ficam em `products.ts` até a Task 6.
- `src/lib/scr/queries.ts`:
  - `confirmPublicScrAuthorization` devolve também `"expired"`.
  - `issueSelfScrAuthorization(identity, id, input)`: `input.notification` ganha `phone?: string | null`. O `update` grava também `request_expires_at = now() + interval '7 days'` e `phone_e164 = coalesce($phone, phone_e164)`. Com telefone, enfileira na mesma transação `scr_authorization` WhatsApp (mesmos parâmetros do e-mail; chave `scr_authorization:whatsapp:<id>:<requested_at>`; `reference` igual). Falha de qualquer enfileiramento desfaz tudo (regra `ScrIssueIsAtomic` atual). `supersede_notifications` continua antes.
  - `resolveScrContact` (D14): `holder_email` volta nulo quando `h.created_by = h.client_profile_id`. Devolve também `phone_e164`.
- `src/actions/scr-self.ts`:
  - `generateCode` com `randomInt(0, CODE_ALPHABET.length)` de `node:crypto` (D32).
  - `sendScrSelfAuthorization` passa `phone: scr.phone_e164`.
  - Mensagem nova: `expired` → `"Este pedido de autorização expirou. Peça um novo a quem solicitou a pesquisa."`.
- `scr-self-authorize-form.tsx`: `expired` mostra a mensagem do resultado e esconde o formulário.

**Testes (casos mínimos):**
- `real client resolves the product id by options.product` (fetch mockado: login com dois produtos; o nome escolhe o id certo); nome desconhecido lança a mensagem com o nome; `DepsRawConsult.product` igual ao nome pedido.
- Python: o setup não pede nem grava `DEPS_PRODUTO_*`.
- `issueSelfScrAuthorization`: grava `request_expires_at` ≈ 7 dias; com telefone enfileira e-mail e WhatsApp; sem telefone só e-mail; falha no WhatsApp (`invalid_recipient`) desfaz código e e-mail.
- `self registered holder email is never the default` (`resolveScrContact`).
- `scr code uses randomInt` (mock devolvendo 0 → `"AAAAAA"`); só letras do alfabeto.
- `confirmScrSelfAuthorization` mapeia `expired` para a mensagem.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/deps src/lib/scr src/actions/scr-self.test.ts` e `python -m pytest scripts/setup` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 3: Pedido — queries, estado, claim e transições

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/orders/types.ts`, `src/lib/orders/labels.ts`
- Create: `src/lib/orders/queries.ts`, `src/lib/orders/queries.integration.test.ts`
- Create: `src/lib/orders/client-queries.ts`, `src/lib/orders/client-queries.integration.test.ts`
- Create: `src/lib/validators/order.ts`, `src/lib/validators/order.test.ts`
- Modify: `src/lib/counter-payments/queries.ts`, `src/lib/counter-payments/queries.integration.test.ts`

**Depends-on:** 1

**Interfaces:**
- `types.ts`:

```ts
export type OrderMode = "online" | "counter";
export type OrderState =
  | "awaiting_payment" | "awaiting_authorization" | "ready" | "executing"
  | "completed" | "released" | "failed" | "cancelled";
export type OrderStateReason =
  | "scr_refused" | "scr_expired" | "payment_timeout" | "cancelled_by_staff"
  | "deps_no_data" | "deps_incompatible" | "deps_unavailable" | "reservation_clawed_back";
export type AiStatus = "none" | "pending" | "done" | "failed";
export type OrderProductCode = "consulta_pf" | "consulta_pj" | "dossie_pj_completo";
export type OpenOrderFailure =
  | "not_allowed" | "invalid_input" | "product_not_for_sale" | "addon_not_for_sale"
  | "kind_mismatch" | "self_holder_missing" | "contact_is_buyer" | "buyer_not_found";
export type OpenOrderInput = {
  productCode: OrderProductCode;
  withAi: boolean;
  self: boolean;
  subject: { type: "PF" | "PJ"; name: string; documentDigits: string } | null;
  partners: { documentDigits: string; name: string | null; email: string | null; percentage: number | null; role: string | null }[];
  contact: { email: string | null; phoneE164: string | null };
  buyerProfileId: string | null;
};
export const MAX_EXECUTION_ATTEMPTS = 5;
export const MAX_AI_ATTEMPTS = 3;
export const LEASE_MINUTES = 5;
export const PAYMENT_WINDOW_DAYS = 7;
```

- `labels.ts`: `ORDER_STATE_LABEL: Record<OrderState, string>` ("Aguardando pagamento", "Aguardando autorização do titular", "Na fila", "Em consulta", "Concluída", "Liberada", "Não concluída", "Cancelada") e `ORDER_REASON_LABEL: Record<OrderStateReason, string>` ("Autorização recusada", "Autorização expirada", "Pagamento não recebido no prazo", "Cancelada pela equipe", "Sem dados na consulta", "Resposta incompatível", "Serviço indisponível", "Pagamento estornado"). Sem teste (tabela).
- `queries.ts` (todas recebem o `PoolClient` da transação do chamador, salvo `placeOrder`):

```ts
export function openOrder(client: PoolClient, input: OpenOrderInput):
  Promise<{ ok: true; dossierId: string; state: OrderState } | { ok: false; reason: OpenOrderFailure }>;
// Uma transação: openOrder → reserveOrder → (balcão) refreshOrderState. Falha da reserva lança e desfaz tudo.
export function placeOrder(identity: DbIdentity, input: OpenOrderInput, quote: OrderQuote):
  Promise<{ ok: true; dossierId: string; state: OrderState } | { ok: false; reason: OpenOrderFailure | SettlementFailure }>;
export function refreshOrderState(client: PoolClient, dossierId: string): Promise<OrderState | null>;
export function claimOrders(client: PoolClient, limit: number, dossierId?: string): Promise<{ dossierId: string; attempts: number }[]>;
export type ExecutionMember = { consultationId: string; type: "PF" | "PJ"; document: string; name: string | null;
  product: string; holderId: string; status: string; scrEmail: string | null; isMain: boolean };
export function getExecutionPlan(client: PoolClient, dossierId: string):
  Promise<{ order: { dossierId: string; mode: OrderMode; withAi: boolean; attempts: number; kind: "PF" | "PJ" | "PJ_FULL" }; members: ExecutionMember[] } | null>;
export function completeOrder(client: PoolClient, identity: DbIdentity, dossierId: string): Promise<"completed" | "failed">;
export function retryOrderLater(client: PoolClient, identity: DbIdentity, dossierId: string, attempts: number): Promise<"ready" | "failed">;
export function failOrder(client: PoolClient, identity: DbIdentity, dossierId: string, reason: OrderStateReason): Promise<void>;
export function cancelOrder(client: PoolClient, identity: DbIdentity, dossierId: string, reason: OrderStateReason):
  Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" }>;
export function releaseDelivery(client: PoolClient, identity: DbIdentity, dossierId: string, siteUrl: string):
  Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" | "no_buyer" }>;
export function revokeDelivery(client: PoolClient, identity: DbIdentity, dossierId: string, reason: string):
  Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" }>;
export function expireScrRequests(client: PoolClient, identity: DbIdentity): Promise<number>;
export function cancelStalledOrders(client: PoolClient, identity: DbIdentity): Promise<number>;
export function listScrRequestsToIssue(client: PoolClient, limit: number):
  Promise<{ scrId: string; holderId: string; type: "PF" | "PJ"; document: string; name: string; email: string; phoneE164: string | null }[]>;
export function listOrdersToPromote(client: PoolClient, limit: number): Promise<string[]>;
export function listOrdersForAi(client: PoolClient, limit: number): Promise<{ dossierId: string; kind: "PF" | "PJ" | "PJ_FULL"; aiAttempts: number }[]>;
export function setAiStatus(client: PoolClient, dossierId: string, status: AiStatus, attempts: number): Promise<void>;
export function listOnlineOrdersToRelease(client: PoolClient, limit: number): Promise<string[]>;
export type StaffOrderView = { dossierId: string; mode: OrderMode; state: OrderState; reason: OrderStateReason | null;
  productCode: OrderProductCode; withAi: boolean; aiStatus: AiStatus; buyerName: string | null; price: string;
  paidTotal: string | null; releasedAt: Date | null; revokedAt: Date | null; revokeReason: string | null; createdAt: Date };
export function getStaffOrder(client: PoolClient, dossierId: string): Promise<StaffOrderView | null>;
```

- Regras por função:
  - `openOrder`: `select ok, reason, dossier_id, state from open_order($1..$10)`; `partners` vai como `jsonb`.
  - **`claimOrders` (forma exata — trava):**

```sql
update dossier_orders o
   set state = 'executing', lease_until = now() + make_interval(mins => $3),
       attempts = o.attempts + 1, updated_at = now()
 where o.dossier_id in (
   select q.dossier_id from dossier_orders q
    where q.bureau_id = app_bureau_id()
      and ((q.state = 'ready' and (q.next_attempt_at is null or q.next_attempt_at <= now()))
           or (q.state = 'executing' and q.lease_until < now()))
      and ($2::uuid is null or q.dossier_id = $2)
    order by q.created_at
    limit $1
    for update skip locked)
returning o.dossier_id, o.attempts
```

    Antes de devolver um pedido `ready`, o claim não confere a autorização de novo: `refresh_order_state` roda no tick antes (passo "promover"). A lease vencida conta como tentativa.
  - `completeOrder`: `captureOrder`. `clawedBack` → `failOrder(..., "reservation_clawed_back")` sem nova liberação (o fechamento já foi gravado) e devolve `"failed"`. Sucesso → `state = 'completed'`, `lease_until = null`, `ai_status = with_ai ? 'pending' : 'none'`, auditoria `order.complete`. `ok: false` da captura lança erro (rollback; a lease vence e o tick tenta de novo).
  - `retryOrderLater`: `attempts >= MAX_EXECUTION_ATTEMPTS` → `failOrder(..., "deps_unavailable")` e `"failed"`; senão `state = 'ready'`, `lease_until = null`, `next_attempt_at = now() + least(2^(attempts−1), 60) minutos`.
  - `failOrder`: `releaseOrder`; `state = 'failed'`, `state_reason`, `lease_until = null`; `dossiers.status` via `refreshDossierStatus`; auditoria `order.fail` (metadata `reason`).
  - `cancelOrder`: só de `awaiting_payment | awaiting_authorization | ready` (`invalid_state` nos outros; trava a linha com `for update`); `releaseOrder`; `state = 'cancelled'`; `update dossiers set status = 'cancelled'`; consultas `pending_authorization` → `rejected`; timeline `order.cancelled`; auditoria `order.cancel`.
  - `releaseDelivery`: só de `completed` com `ai_status <> 'pending'`; sem comprador → `no_buyer`; `state = 'released'`, `released_at = now()`, `released_by = identity.userId`; timeline `order.released`; auditoria `order.release`; aviso `research_released` (D22): e-mail para `profiles.email` do comprador sempre; WhatsApp para `profiles.phone_e164` quando `notification_channel = 'whatsapp'` e `phone_verified_at` não nulo; `params = { clientName: primeiro nome, url: \`${siteUrl}/portal/pesquisas/${dossierId}\` }`; chave `research_released:<canal>:<dossierId>:<epoch de released_at>`; `reference = order:<dossierId>`. Falha do enfileiramento lança (rollback).
  - `revokeDelivery`: só de `released`; motivo `trim` 1–500; `state = 'completed'`, `revoked_at`, `revoked_by`, `revoke_reason`; timeline `order.revoked`; auditoria `order.revoke` (sem o texto do motivo na metadata). Sem aviso.
  - `expireScrRequests`: `pending` com `request_expires_at < now()` do Bureau → `expired`, `auth_code = null`; timeline `scr.expired` por linha.
  - `cancelStalledOrders`: `awaiting_authorization` com alguma consulta ligada a SCR `not_authorized` → `cancelOrder(..., "scr_refused")`; com `expired` → `"scr_expired"`; balcão `awaiting_payment` com `created_at < now() − 7 dias` → `"payment_timeout"`.
  - `listScrRequestsToIssue`: linhas SCR `pending`, `auth_code is null`, ligadas a consulta de pedido `awaiting_authorization`; também linha `authorized` vencida ligada a pedido `awaiting_authorization` → insere linha `pending` nova no mesmo escopo (mesma regra do passo 10 de `open_order`), religa a consulta e a devolve.
  - `listOrdersToPromote`: pedidos `awaiting_authorization` e `ready` do Bureau (o tick chama `refreshOrderState` em cada um).
  - `listOnlineOrdersToRelease`: `mode = 'online'`, `state = 'completed'`, `ai_status <> 'pending'`, `revoked_at is null` (pedido revogado não volta sozinho).
- `client-queries.ts` (identidade do cliente, sob RLS; sem `holders`):

```ts
export type ClientOrderListItem = { dossierId: string; productCode: OrderProductCode; withAi: boolean; subjectName: string;
  subjectDocumentMasked: string; state: OrderState; reason: OrderStateReason | null; price: string; createdAt: Date; releasedAt: Date | null };
export function listMyOrders(client: PoolClient, limit?: number): Promise<ClientOrderListItem[]>;   // join order_settlements (preço; nunca custo)
export type ClientDelivery = { order: ClientOrderListItem; kind: "PF" | "PJ" | "PJ_FULL";
  members: { consultationId: string; type: "PF" | "PJ"; name: string | null; product: string | null; status: string; canonical: CanonicalBureauResult | null; opinion: Parecer | null }[];
  dossierOpinion: Parecer | null };
export function getMyDelivery(client: PoolClient, dossierId: string): Promise<ClientDelivery | null>; // null fora de 'released'
```

- `src/lib/validators/order.ts`:
  - `clientOrderSchema`: `productCode` em (`consulta_pf`, `consulta_pj`); `withAi`; `self`; `subject` (`name` 2–120, `document`) e `contactEmail` obrigatórios quando `!self`; `contactPhone` opcional (até 30); `superRefine`: CPF válido para `consulta_pf`, CNPJ válido para `consulta_pj` (`isValidCPF`, `isValidCNPJ`), mensagens "CPF inválido." / "CNPJ inválido."; transform com `documentDigits`.
  - `counterOrderSchema`: `productCode` nos três; `withAi`; `buyerProfileId` uuid ou nulo; `subject` obrigatório; `contactEmail` e `contactPhone` opcionais; `partners` (só `dossie_pj_completo`; até 20; CPF válido) com `email` opcional.
  - `orderIdSchema` (uuid) e `revokeSchema` (`dossierId`, `reason` 1–500 com `trim`).
- `src/lib/counter-payments/queries.ts`: `registerCounterPayment` e `voidCounterPayment` chamam `refreshOrderState(client, dossierId)` na mesma transação, depois do insert ou da anulação.

**Testes (casos mínimos):**
- `queries.integration.test.ts` (`acquireClaimLock`; Bureau com produtos à venda e carteiras com saldo pelo seed):
  - `insufficient balance leaves no dossier, order or scr row` (online e balcão).
  - `placeOrder online reserves P on the client wallet`; `placeOrder counter reserves C on the bureau wallet and stays awaiting_payment`.
  - `two concurrent claims return disjoint orders` (duas transações em paralelo); `expired lease is claimed again`; `next_attempt_at in the future is not claimed`.
  - `completeOrder captures and sets ai_status`; `clawed back capture fails the order without delivery`.
  - `cancel and fail release the reservation exactly once` (saldo volta uma vez; repetir não muda saldo); `cancel after executing is invalid_state`.
  - `retryOrderLater backs off and fails on the fifth attempt` (release feito).
  - `releaseDelivery enqueues email always and whatsapp only for whatsapp channel`; `no buyer is no_buyer`; `release of a pending ai order is invalid_state`; auditoria e timeline gravadas.
  - `revokeDelivery requires a reason and hides the delivery from the client`.
  - `expireScrRequests and cancelStalledOrders cancel and release` (recusa, expiração, prazo de pagamento).
  - `expired authorization is re-requested in the same scope`.
- `client-queries.integration.test.ts`: `listMyOrders returns only own orders with the subject snapshot and price`; `getMyDelivery is null before release and after revoke`; com liberação devolve resultado canônico e parecer.
- `counter-payments/queries.integration.test.ts`: `payment equal to price moves the order out of awaiting_payment`; `void before execution moves it back`.
- `order.test.ts`: PF com CNPJ e PJ com CPF recusados; terceiro sem e-mail recusado; própria sem `subject` passa; sócio só no PJ completo; motivo vazio recusado.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/orders src/lib/validators/order.test.ts src/lib/counter-payments` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 4: Execução, parecer IA e tick

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/orders/execute.ts`, `src/lib/orders/execute.test.ts`
- Create: `src/lib/orders/ai.ts`, `src/lib/orders/ai.test.ts`
- Create: `src/lib/orders/tick.ts`, `src/lib/orders/tick.integration.test.ts`
- Create: `src/lib/settings/readers.ts`, `src/lib/ai/persist.ts`
- Modify: `src/actions/settings.ts` (delega a `readers.ts`), `src/actions/ai.ts` (delega a `persist.ts`)
- Create: `src/app/api/internal/orders/tick/route.ts`, `src/app/api/internal/orders/tick/route.test.ts`
- Modify: `scripts/notifications-cron.mjs`, `scripts/notifications-cron.test.mjs`, `docker-stack.yml`

**Depends-on:** 1, 2, 3

**Interfaces:**
- `src/lib/settings/readers.ts` (sem `"use server"`): `readAiPrompt(identity, kind: AiPromptKind): Promise<string>` e `readScrTermSettings(identity): Promise<ScrTermSettings>`, com a lógica atual de `getAiPrompt` e `getScrTermSettings`. As ações de `settings.ts` passam a chamar os leitores com a identidade da sessão; o comportamento não muda.
- `src/lib/ai/persist.ts`: `saveConsultationOpinion(client, identity, consultationId, holderId, result)` com o insert `on conflict` atual de `src/actions/ai.ts` (sucesso e erro, timeline e auditoria iguais). `generateOpinion` passa a usá-lo.
- `src/lib/orders/execute.ts`:

```ts
export type RunOutcome = "completed" | "failed" | "retry" | "not_claimed";
export function runOrderNow(identity: DbIdentity, dossierId: string): Promise<RunOutcome>;
export function runReadyOrders(identity: DbIdentity, limit: number): Promise<{ dossierId: string; outcome: RunOutcome }[]>;
```

  - Claim (`claimOrders`) numa transação curta; depois, fora de transação, por membro (principal primeiro; membro já `completed` é pulado):
    1. `consultations.status = 'processing'`.
    2. `getDepsClient().consultPF|consultPJ(document, { product: member.product, reuseExisting: attempts > 1, authorization: { name, email: scrEmail }, autorizacaoScr: true })`.
    3. `executeConsultation({ identity, consultationId, entityKind, consult: async () => raw })`.
    4. Principal: `completed` segue; `no_data` ou `DepsScrPendingError` → `failOrder("deps_no_data")`, fim; `payload_incompatible` → `failOrder("deps_incompatible")`, fim; outro erro antes da resposta → `retryOrderLater`, fim.
    5. Sócio: `no_data`, `payload_incompatible` ou erro → consulta `error` com `error_message` curto (sem documento); segue para o próximo.
    6. Membro `completed`: timeline `query.executed` ("Consulta realizada", descrição só com o nome do produto).
  - Fim com principal `completed`: `refreshDossierStatus` e `completeOrder` numa transação.
  - `error_message` e logs nunca levam documento nem corpo da DEPS.
- `src/lib/orders/ai.ts`: `generateOrderAi(identity, dossierId, kind): Promise<"done" | "failed">`. PF/PJ: `generateParecer` com o canônico da consulta principal e `readAiPrompt(identity, "pf" | "pj")`, depois `saveConsultationOpinion`. PJ completo: `generateCompanyParecer` com empresa e sócios concluídos, `readAiPrompt(identity, "empresa")`, depois `saveDossierReport`. Exceção → `"failed"` (sem log do conteúdo).
- `src/lib/orders/tick.ts`:

```ts
export type TickResult = { bureaus: number; expired: number; cancelled: number; requested: number;
  promoted: number; executed: number; ai: number; released: number; errors: number };
export const TICK_EXECUTION_LIMIT = 5;
export function runOrdersTick(): Promise<TickResult>;
```

  - `select bureau_id, system_profile_id from due_order_bureaus()` pelo `pool`. Para cada Bureau, identidade `{ userId: system_profile_id, role: "operator", bureauId }`; cada passo na sua transação; erro num passo conta em `errors`, loga só nome e código e segue para o próximo passo e Bureau.
  - Ordem: `expireScrRequests` → `cancelStalledOrders` → emitir pedidos (`listScrRequestsToIssue` → `buildScrConsentTerm` com `readScrTermSettings` → `issueSelfScrAuthorization` com `phone`; timeline `scr.requested`; uma transação por pedido) → promover (`listOrdersToPromote` → `refreshOrderState`) → executar (`runReadyOrders` com o que sobra de `TICK_EXECUTION_LIMIT` no tick inteiro) → parecer (`listOrdersForAi` → `generateOrderAi` → `setAiStatus`: `done`; ou `failed` na `MAX_AI_ATTEMPTS`-ésima falha; senão `pending` com `ai_attempts + 1`) → liberar online (`listOnlineOrdersToRelease` → `releaseDelivery` com `config.betterAuthUrl`).
- Rota `POST /api/internal/orders/tick`: cópia do modelo de `api/internal/notifications/dispatch/route.ts` (`readNotificationsDispatchSecret`, `timingSafeEqual` sobre hash, 401, 405 nos outros métodos, `dynamic = "force-dynamic"`); chama `runOrdersTick()`; `errors > 0` → 500 com o JSON; exceção → 500 sem corpo. Confira que `src/middleware.ts` deixa `/api/internal/` passar sem sessão.
- `scripts/notifications-cron.mjs`: depois de cada dispatch, se `ORDERS_TICK_URL` existe, faz o mesmo POST (mesmo segredo, mesmo timeout, mesma regra de http em host externo) e loga `orders-tick status=...`. Sem a variável, nada muda. `docker-stack.yml`: `ORDERS_TICK_URL` no serviço do cron, com o mesmo host interno do dispatch.

**Testes (casos mínimos):**
- `execute.test.ts` (mocks de `getDepsClient`, `executeConsultation`, queries de pedido e transação):
  - principal `completed` → `completeOrder`; `retry after lease uses reuseExisting` (`attempts = 2`);
  - erro de rede no principal → `retryOrderLater`; `no_data` e `DepsScrPendingError` → `failOrder("deps_no_data")`; `payload_incompatible` → `failOrder("deps_incompatible")`;
  - sócio com erro não impede a conclusão; principal com falha não chama a DEPS para os sócios;
  - `not_claimed` quando o claim volta vazio; nenhum log contém o documento.
- `ai.test.ts`: PF chama `generateParecer` e `saveConsultationOpinion`; PJ completo chama `generateCompanyParecer` e `saveDossierReport`; exceção → `"failed"`.
- `tick.integration.test.ts` (banco real; DEPS e IA mockadas; `acquireClaimLock`) — **cenário crítico de dinheiro, uma execução**: `online order end to end debits P from the client and accrues P minus C`: pedido online de terceiro com parecer IA → tick emite e-mail SCR → `confirm_public_scr_authorization` com o código lido pelo dono → tick promove, executa, captura, gera parecer e libera → carteira do cliente perde `P`, `bureau_payable_entries` ganha `P − C`, notificação `research_released` na fila, cliente lê a entrega. Também: `expired request cancels and releases on the tick`; `counter order without payment for 7 days is cancelled` (ajuste `created_at` pelo dono); um Bureau com erro não para o outro.
- `route.test.ts`: `tick route refuses a wrong secret` (401, `runOrdersTick` não chamado); GET → 405; configuração inválida → 500; `errors > 0` → 500.
- `notifications-cron.test.mjs`: chama `ORDERS_TICK_URL` depois do dispatch; sem a variável, não chama.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/orders src/app/api/internal/orders src/actions/ai.test.ts src/actions/settings.test.ts` e `node --test scripts/notifications-cron.test.mjs` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 5: Server Actions, PDF do cliente e remoção das ações antigas

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/actions/orders.ts`, `src/actions/orders.test.ts`
- Create: `src/actions/orders-client.ts`, `src/actions/orders-client.test.ts`
- Create: `src/app/(portal)/portal/pesquisas/[id]/pdf/route.ts`, `src/app/(portal)/portal/pesquisas/[id]/pdf/route.test.ts`
- Modify: `src/actions/consultations.ts`, `src/actions/consultations.test.ts`
- Modify: `src/actions/dossiers.ts`, `src/actions/dossiers.test.ts`
- Modify: `src/actions/scr.ts`, `src/actions/scr.test.ts`
- Modify: `src/lib/dossiers/queries.ts`

**Depends-on:** 3, 4

**Interfaces:**
- `src/actions/orders-client.ts` (`"use server"`):
  - Helper não exportado `requireClient()` (modelo de `account.ts`): `role === "client"` e `portal:write`; senão `"Ação não permitida."`.
  - `openClientOrderAction(values: unknown): Promise<ActionResult>`: `clientOrderSchema` → `requireClient` → `toE164(contactPhone)` (inválido → `"Celular inválido. Use DDD e número."`) → cotação (D26): slug do Bureau do cliente (`select slug from bureaus where id = app_bureau_id()`), `getPublicCatalog(slug)`, linhas `{ code, priceCents, costCents: 0, productVersionId: "" }` do produto e do adicional; item ausente → mensagem de `product_not_for_sale` → `placeOrder(session, input, quote)` → `revalidatePath("/portal/pesquisas")` → `{ error: null, id: dossierId }`. O valor nunca vem do formulário.
- `src/actions/orders.ts` (`"use server"`):
  - Helper não exportado `requireStaffWriter()`: `consultations:write`; sessão de suporte → `"Encerre a sessão de suporte para operar pedidos."`.
  - `openCounterOrderAction(values)`: `counterOrderSchema` → `quoteOrder(session, productCode, { withAi })` → `placeOrder` → `revalidatePath("/dossiers")`.
  - `runOrderNowAction(dossierId)`: `orderIdSchema` → `runOrderNow(session, id)`; `not_claimed` → `"O pedido não está pronto para execução."`; `retry` → `"Serviço da consulta indisponível. Nova tentativa automática em alguns minutos."`; `failed` → `"A consulta não foi concluída. A reserva foi liberada."`.
  - `cancelOrderAction(dossierId)`, `releaseOrderAction(dossierId)` (usa `config.betterAuthUrl`), `revokeOrderAction(values)` (`revokeSchema`), cada um em `withUserTransaction` com a query da Task 3 e `revalidatePath(\`/dossiers/${id}\`)`.
- Mensagens comuns: `insufficient_balance` → cliente `"Saldo insuficiente. Compre créditos para continuar."`, equipe `"Saldo do Bureau insuficiente para reservar o custo. Recarregue a carteira."`; `product_not_for_sale` → `"Produto indisponível neste Bureau."`; `addon_not_for_sale` → `"Parecer IA indisponível para este produto."`; `kind_mismatch` → `"O documento não combina com o produto."`; `self_holder_missing` → `"Sua conta não tem Titular. Fale com o Bureau."`; `contact_is_buyer` → `"Informe o e-mail e o celular do titular, não os seus."`; `buyer_not_found` → `"Cliente comprador não encontrado neste Bureau."`; `no_buyer` → `"Este pedido não tem cliente comprador. Entregue o PDF pela equipe."`; `invalid_state` → `"O pedido mudou de estado. Recarregue a página."`; `not_found` → `"Pedido não encontrado."`; outros e exceção → `logFailure` e `"Não foi possível concluir. Tente novamente."`.
- PDF do cliente `GET /portal/pesquisas/[id]/pdf` (`runtime = "nodejs"`, `dynamic = "force-dynamic"`): sessão (401), `role === "client"` e `portal:read` (403), `isUuid` e `getMyDelivery` em `withUserTransaction` (nulo → 404), `renderDossierPdf` com `letterheadDataUri()` e as entradas montadas como no PDF da equipe, com `subjectName`/`subjectDocumentMasked` do pedido no cabeçalho do Dossiê. `Content-Disposition: attachment; filename="pesquisa-<8 primeiros do id>.pdf"`.
- Remoção (D2, D28): saem `runConsultation`, `reprocessQuery` e `setConsultationStatus` (`consultations.ts`); `createDossier` e `processDossierMember` (`dossiers.ts`; fica `generateDossierReport`); `verifyScr` e `retryScrByQuery` (`scr.ts`; fica `resendScr`). Em `src/lib/dossiers/queries.ts` saem `createDossier`, `insertConsultation` e o import de `depsProductName`; `listDossiers` devolve também `order_state` (`left join dossier_orders`). Apague os testes das funções removidas; remova imports órfãos.

**Testes (casos mínimos):**
- `orders-client.test.ts`: operador, admin e sessão inválida → `"Ação não permitida."`; zod recusa sem chamar `placeOrder`; `the price comes from the public catalog, never from the form` (formulário com `price` extra é ignorado; cotação do catálogo); cada `reason` vira a mensagem da lista; celular inválido não chama `placeOrder`.
- `orders.test.ts`: sem `consultations:write` e com sessão de suporte recusados; cada ação mapeia seus motivos; `runOrderNowAction` mapeia os quatro resultados; `revokeOrderAction` sem motivo não chama a query.
- `route.test.ts`: 401 sem sessão; 403 para equipe; `client pdf route returns 404 for another client or an unreleased order`; 200 com `application/pdf` para entrega liberada (renderer mockado).
- `consultations.test.ts`, `dossiers.test.ts`, `scr.test.ts`: casos das funções que ficam continuam verdes.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/actions src/app/\(portal\)/portal/pesquisas` até ficar verde.
- [ ] Entregue: lista de `Files changed` (inclui os componentes que ainda importam as ações removidas: a Task 6 os corrige).

---

### Task 6: Telas do balcão e da equipe

**Agent:** `frontend-specialist` · `model: "sonnet"`
**Files:**
- Modify: `src/components/dossiers/dossier-form.tsx`
- Create: `src/components/dossiers/order-panel.tsx`, `src/components/dossiers/revoke-order-dialog.tsx`
- Modify: `src/app/(dashboard)/dossiers/new/page.tsx`, `src/app/(dashboard)/dossiers/[id]/page.tsx`, `src/app/(dashboard)/dossiers/page.tsx`
- Modify: `src/app/(dashboard)/consultations/new/page.tsx` (redireciona), `src/app/(dashboard)/consultations/[id]/page.tsx`
- Delete: `src/components/consultations/consultation-form.tsx`, `src/components/consultations/reprocess-button.tsx`, `src/components/consultations/retry-scr-button.tsx`, `src/components/dossiers/process-pending-button.tsx`
- Modify: `src/app/(dashboard)/settings/users/page.tsx` (filtro `not is_system`)
- Modify: `src/lib/deps/products.ts`, `src/lib/deps/products.test.ts` (sai `depsProductName`)

**Depends-on:** 5

**Interfaces:**
- Consumes: `openCounterOrderAction`, `runOrderNowAction`, `cancelOrderAction`, `releaseOrderAction`, `revokeOrderAction` (Task 5); `getStaffOrder`, `ORDER_STATE_LABEL`, `ORDER_REASON_LABEL` (Task 3); `counterOrderSchema` (Task 3); `listCatalog` (M2); `searchHolders` (fica em `consultations.ts`); `listCounterPayments` e o diálogo de registro existente de `src/components/counter-payments/*`.

**Contrato:**
- Invoque `/ui-ux-pro-max` antes de escrever UI. Siga `src/components/CLAUDE.md` e o padrão de `dossier-form.tsx` atual (react-hook-form + `zodResolver`).
- `DossierForm` vira o formulário do pedido de balcão: produto (`select` com os itens à venda do catálogo e o preço), "Incluir parecer IA" (só com o adicional à venda), comprador opcional (busca de Titular com conta no portal; mostra "Sem comprador: a entrega fica com a equipe"), titular (tipo, nome, documento, consulta de CNPJ atual), e-mail e celular do titular, sócios (só PJ completo). Envio → `openCounterOrderAction` → `router.push(\`/dossiers/${id}\`)`. A página `/dossiers/new` carrega o catálogo no servidor.
- `/consultations/new` → `redirect("/dossiers/new")`.
- `OrderPanel` (no topo de `/dossiers/[id]`; dados de `getStaffOrder` carregados na página): selo do estado e motivo, comprador, preço, total pago (balcão), estado do parecer IA ("Parecer IA falhou" em `failed`), datas de liberação e revogação. Botões por estado: `awaiting_payment` → "Registrar pagamento" (diálogo existente); `awaiting_payment | awaiting_authorization | ready` → "Cancelar pedido" (com confirmação); `ready` → "Executar agora"; `completed` (balcão, sem parecer pendente) → "Liberar ao cliente"; `released` → "Revogar" (`RevokeOrderDialog` com motivo obrigatório). Sem pedido (dados antigos de dev): o painel não aparece.
- Remova os usos de `ProcessPendingButton`, `ReprocessButton` e `RetryScrButton` e apague os arquivos.
- `/dossiers`: selo do estado do pedido (`order_state`) ao lado do estado do Dossiê.
- `/settings/users`: a query da página filtra `not p.is_system`.
- `products.ts`: apague `depsProductName` e o comentário das variáveis de ambiente; mantenha `DEPS_PRODUCT_PF|PJ` (fallback dos PDFs e teste do seed). Ajuste `products.test.ts`.
- Textos em pt-BR; estados de carregamento e erro visíveis; rótulos acessíveis.

**Testes:** UI de apresentação não leva teste; regras e mensagens estão nas Tasks 1–5. Verificação visual: `npm run dev` com `WHATSAPP_DRIVER=fake` e DEPS mockada ou de homologação; abra um pedido de balcão, registre o pagamento, rode o tick (`curl -X POST -H "Authorization: Bearer $NOTIFICATIONS_DISPATCH_SECRET" localhost:3000/api/internal/orders/tick`), confirme a autorização pelo link, execute, libere e revogue. Se não for possível abrir o navegador, diga isso no relatório.

- [ ] Implemente, rode `npm run lint && npm run type-check` (deve passar só depois da Task 7 também; reporte os erros que restam fora dos seus arquivos).
- [ ] Verifique as telas no navegador, ou declare que não verificou.
- [ ] Entregue: lista de `Files changed`.

---

### Task 7: Portal — pesquisas e entregas

**Agent:** `frontend-specialist` · `model: "sonnet"`
**Files:**
- Modify: `src/app/(portal)/layout.tsx`, `src/app/(portal)/portal/page.tsx`
- Create: `src/app/(portal)/portal/pesquisas/page.tsx`
- Create: `src/app/(portal)/portal/pesquisas/nova/page.tsx`
- Create: `src/app/(portal)/portal/pesquisas/[id]/page.tsx`
- Create: `src/components/orders/client-order-form.tsx`, `src/components/orders/client-order-list.tsx`, `src/components/orders/delivery-view.tsx`

**Depends-on:** 5

**Interfaces:**
- Consumes: `openClientOrderAction` (Task 5); `listMyOrders`, `getMyDelivery` (Task 3); `ORDER_STATE_LABEL`, `ORDER_REASON_LABEL`, `clientOrderSchema` (Task 3); `getPublicCatalog`; `getClientWallet` (`src/lib/wallet/client-queries.ts`); `getClientAccountStatus` (M5, para o documento mascarado próprio); `ConsultationResult` e a parte de leitura de `ConsultationOpinion` (`src/components/consultations/*`, sem botões de gerar); `MarkdownReport`.

**Contrato:**
- Invoque `/ui-ux-pro-max` antes de escrever UI. Siga o layout atual do portal (`max-w-3xl`, `Card`).
- Layout: link "Pesquisas" (`/portal/pesquisas`) antes de "Créditos".
- `/portal`: o cartão "Suas pesquisas" mostra as 5 últimas (`listMyOrders(c, 5)`) com estado e link "Ver todas"; sem pedido, o texto atual e o botão "Nova pesquisa".
- `/portal/pesquisas` (server, `portal:read`): botão "Nova pesquisa"; `ClientOrderList` com produto, titular (nome e documento mascarado), selo do estado (motivo em `failed | cancelled`), data, preço; linha leva a `/portal/pesquisas/<id>`.
- `/portal/pesquisas/nova` (server): carrega catálogo público do Bureau do cliente (só `consulta_pf` e `consulta_pj`), saldo disponível e o documento mascarado próprio. `ClientOrderForm` (`"use client"`, `zodResolver(clientOrderSchema)`): produto; "Para quem é a pesquisa?" → "Para mim ({documento mascarado})" ou "Para outra pessoa" (nome, CPF/CNPJ conforme o produto, e-mail e celular do titular, com o texto "O titular recebe um pedido de autorização por e-mail e, se informado, por WhatsApp. A consulta só roda depois da autorização."); "Incluir parecer IA (+ preço)" quando à venda; total; saldo; saldo menor que o total → aviso e link "Comprar créditos" no lugar do botão. "Confirmar pedido" → `openClientOrderAction` → `router.push(\`/portal/pesquisas/${id}\`)`.
- `/portal/pesquisas/[id]` (server): pedido de `listMyOrders` filtrado (404 se não é do cliente); estado e o próximo passo em texto ("Aguardando a autorização do titular. O pedido expira em 7 dias sem resposta.", "Consulta em andamento.", "Concluída. Aguardando liberação do Bureau.", motivo em falha ou cancelamento, "A reserva foi devolvida ao seu saldo."). Em `released`: `DeliveryView` com, por membro, `ConsultationResult` e o parecer (só leitura), parecer consolidado do PJ completo, e "Baixar PDF" (`/portal/pesquisas/<id>/pdf`).
- Textos em pt-BR; estados de carregamento e erro visíveis; rótulos acessíveis; `aria-live` na mensagem de erro do envio.

**Testes:** `ClientOrderForm` tem renderização condicional (para mim / outra pessoa / saldo insuficiente), mas a validação está em `clientOrderSchema` (Task 3) e as regras no SQL; sem teste de componente. Verificação visual: cliente com saldo faz pedido próprio e de terceiro; lê o código no console do driver fake ou na tabela `notifications` (como dono) antes do worker; autoriza pelo link; roda o tick; vê a entrega e baixa o PDF; cliente sem saldo vê o aviso. Se não for possível abrir o navegador, diga isso no relatório.

- [ ] Implemente, rode `npm run lint && npm run type-check`.
- [ ] Rode `npm run build`.
- [ ] Verifique as telas no navegador, ou declare que não verificou.
- [ ] Entregue: lista de `Files changed`.

---

### Task 8: Documentação

**Agent:** `documentation-writer` · `model: "haiku"`
**Files:**
- Modify: `docs/architecture.md`
- Modify: `PRODUCT.md`
- Modify: `docs/operations/notifications.md`
- Create: `docs/operations/orders.md`

**Depends-on:** 1

**Contrato:**
- `docs/architecture.md`: faixa de migrations `001` a `022`; uma linha sobre a 022 (`dossier_orders`, `open_order`, perfil de sistema, RLS de entrega do cliente); uma linha sobre o tick (`/api/internal/orders/tick`, identidade de sistema).
- `PRODUCT.md`: linha do M6 "em execução" com link para a spec; próximo passo.
- `docs/operations/notifications.md`: templates `scr_authorization` (WhatsApp v1) e `research_released` (e-mail v1, WhatsApp v1), registrados pela 022; aprovação na Meta como post-deploy.
- `docs/operations/orders.md` (runbook curto): estados do pedido (tabela da spec), `ORDERS_TICK_URL` no cron, como rodar o tick à mão, como ver um pedido preso (`select dossier_id, state, attempts, lease_until, next_attempt_at from dossier_orders where state in ('executing', 'ready')`), prazos (7 dias de pedido SCR e de pagamento, 5 tentativas, lease de 5 minutos).
- Textos em pt-BR, ASD-STE100. Sem outra mudança.

**Testes:** nenhum (documentação). Gate: `npm run lint` passa.

- [ ] Edite os arquivos.
- [ ] Entregue: lista de `Files changed`.

---

## Critérios de pronto

Cada critério aponta para o teste que o prova (lista da spec).

- Pedido online próprio e de terceiro numa transação; saldo insuficiente não deixa linha (Task 1: `client opens an own order in one transaction`; Task 3: `insufficient balance leaves no dossier, order or scr row`).
- Titular existente não muda; contato do comprador recusado (Task 1).
- `reserve_order` com posse pelo pedido (Task 1).
- Reuso no mesmo escopo; outro comprador gera pedido novo (Task 1).
- Pedido SCR por e-mail e WhatsApp, prazo de 7 dias, `expired` (Task 1, 2).
- Recusa e expiração cancelam e liberam; timeline do Titular (Task 3, 4).
- Balcão: reserva do custo, pagamento ≥ preço, anulação, prazo de 7 dias (Task 1, 3, 4).
- Execução única por lease (Task 3).
- Captura online `P` e acréscimo `P − C`; balcão `C` (Task 4: `online order end to end debits P from the client and accrues P minus C`; Task 3: `placeOrder counter reserves C`).
- Transitório reagenda; terminal falha e libera (Task 3, 4).
- Parecer IA quando comprado; falha não prende a entrega (Task 4).
- Liberação online automática, balcão manual, revogação com motivo, auditoria (Task 3, 5).
- Aviso por e-mail sempre e WhatsApp pelo canal (Task 3).
- RLS do cliente (Task 1).
- PDF só da entrega liberada do próprio cliente (Task 5).
- Perfil de sistema fora do login e da equipe (Task 1, 6).
- Nome DEPS de `product_versions` (Task 1, 2, 6).
- Telas (Task 6, 7; verificação visual; `npm run build`).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da onda 5.
- (post-deploy) A Meta aprova `scr_authorization` e `research_released` no WhatsApp (`pt_BR`, utility).
- (post-deploy) Uma pesquisa real na DEPS acha o identificador pelo nome de `product_versions`.
- (post-deploy) O cron do stack chama `ORDERS_TICK_URL` a cada minuto; o log não mostra dados pessoais.
- (post-deploy) Um aviso real de liberação chega por e-mail e por WhatsApp.

Cada item `(post-deploy)` vira um item "Post-deploy follow-up" no PR. Nenhum bloqueia o merge.

## Cobertura da spec

| Spec / issue | Task |
|---|---|
| #42 Escolha de produto e titular (próprio ou terceiro) | 1, 3, 5, 7 |
| #42 Reserva de saldo ao pedir | 1 (`reserve_order`), 3 (`placeOrder`) |
| #43 Pedido de autorização por e-mail/WhatsApp | 1 (template), 2, 4 |
| #43 Autorização reutilizável enquanto válida | 1 (`open_order`, `refresh_order_state`), 3 |
| #43 Trilha de auditoria por titular | 1, 2, 3, 4 (timeline e auditoria) |
| #43 Expiração libera a reserva | 1 (`confirm_*`), 3, 4 |
| #44 Cadastrar cliente e titular | 1 (`open_order`), 6 (formulário; conta pelo convite existente) |
| #44 Registrar pagamento de balcão | 3 (`refreshOrderState`), 6 |
| #44 Enviar autorização e executar consulta | 4, 5, 6 |
| #45 Liberar/revogar auditado | 3, 5, 6 |
| #45 Notificação ao cliente | 1 (template), 3 |
| #46 Relatório na tela | 3 (`getMyDelivery`), 7 |
| #46 PDF com a marca da plataforma | 5 |
| #46 Parecer IA quando comprado | 4 |
| #46 Aviso por e-mail e WhatsApp | 3 |
| #65 Lista com estado | 3, 7 |
| #65 Entrega liberada: tela e PDF | 5, 7 |
| #65 RLS do cliente | 1 |
| #27 Reserva → captura → liberação | 1, 3, 4 |
| #34 Preferência de canal no envio | 3 |
| #36 Versões WhatsApp dos templates | 1 |
| D1, D3, D23, D24, D27 | 1 |
| D2, D28 | 1, 5, 6 |
| D4–D7, D17 | 3, 4 |
| D8–D11 | 1, 3 |
| D12, D14 | 1, 2 |
| D13, D32 | 2 |
| D15 | 1, 6 |
| D16 | 4 |
| D18, D19 | 1, 3, 6 |
| D20–D22 | 3, 4, 5, 6 |
| D25 | 1, 2, 6 |
| D26, D29, D30 | 5 |
| D31 | 1, 2, 3, 4 |

## Ajustes nas issues (fora das tasks)

- Antes da onda 1: confirmar com o usuário a tabela "Decisões a confirmar" da spec.
- `Closes #27` e `Closes #34` no commit da Task 4. `Closes #43`, `Closes #44` e `Closes #45` no commit da Task 6. `Closes #42`, `Closes #46` e `Closes #65` no commit da Task 7. `Closes #36` no commit da Task 4, com o comentário abaixo.
- Comentário no #36:

  > O M6 entrega as versões WhatsApp de `scr_authorization` e `research_released` (migration 022). O convite continua no e-mail de definição de senha do Better Auth (link de uso único com expiração) e não ganha versão WhatsApp. Decisão na spec `docs/superpowers/specs/2026-10-15-m6-pesquisa-e-entrega-design.md`.

- Comentário no #34: "O M6 usa `profiles.notification_channel` no aviso de liberação (D22 da spec do M6)."
- Issue nova no backlog, labels `enhancement`, `backend`:

  ```
  gh issue create --label enhancement --label backend \
    --title "Estorno após captura e reembolso ao cliente" \
    --body-file - <<'EOF'
  O M6 não devolve valor capturado (D7 da spec docs/superpowers/specs/2026-10-15-m6-pesquisa-e-entrega-design.md).

  **Critérios de aceite**
  - [ ] Estorno de pedido online capturado devolve o preço à carteira do cliente
  - [ ] O valor a repassar recebe `reversal` com o mesmo `order_ref`
  - [ ] Ação auditada, só superadmin ou bureau_admin

  **Depende de:** M6
  EOF
  ```
