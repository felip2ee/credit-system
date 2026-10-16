# M5 — Contas de cliente Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute com `superpowers:subagent-driven-development` em **ondas paralelas** (`Files:` / `Depends-on:`, regra `.claude/rules/08-parallel-subagent-driven-development.md`). Os implementadores **não fazem commit**: deixam as mudanças na árvore e reportam `Files changed`. O controlador faz um commit por task, na ordem do plano. Sem reviewer por task. Steps usam checkbox (`- [ ]`).

**Goal:** O cliente PF/PJ cria a própria conta em `/b/<slug>/cadastro`, entra no portal, confirma o e-mail por link e o telefone por código no WhatsApp, e aceita os termos versionados. Só o e-mail confirmado libera a compra de créditos. O portal ganha "Perfil e segurança".

**Architecture:** Uma migration nova, `021_client_accounts.sql`: três colunas em `profiles`, quatro tabelas (`legal_documents`, `legal_acceptances`, `verification_challenges`, `client_register_attempts`), um trigger que fecha as colunas novas para `app_runtime`, e funções `SECURITY DEFINER` (dono `auth_profile_lookup`) que fazem todas as escritas. A aplicação nunca escreve nessas tabelas. Camadas: página → Server Action (`src/actions/register.ts`, `src/actions/account.ts`) → `src/lib/account/queries.ts` → função SQL. O cadastro e a confirmação de e-mail rodam sem sessão (pool, sem contexto); o resto roda em `withUserTransaction` com a identidade do cliente. As notificações saem pela fila do M4, por uma função interna nova (`enqueue_system_notification`).

**Tech Stack:** Next.js 14.2, React 18, Better Auth 1.7.2 (`better-auth/crypto`, `authClient`), PostgreSQL 18 (RLS), node-postgres, zod 3, react-markdown (já instalado), Vitest 4, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-15-m5-contas-de-cliente-design.md`. Issues: #37, #38, #39, #40, #41 (parcial). Branch: crie `feature/m5-contas-de-cliente` a partir de `feature/m4-notificacoes` (migrations 001–020), ou de `main` depois do merge do M4. Aprovação: D1–D4 da spec vêm do usuário e são finais.

## Global Constraints

- Crie só `db/migrations/021_client_accounts.sql` (Task 1). Não edite as migrations 001–020. Recrie o banco de dev antes dos testes de integração: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Testes de integração (`*.integration.test.ts`) rodam contra `127.0.0.1:54329`. Cada task cria os helpers de teste no próprio arquivo. Não edite `src/test/seed.ts` (use `seedTenant`, `seedClientProfile`, `withDbContext`, `randomCpf` como estão).
- Todo arquivo de teste que cria notificação (cadastro, pedido de código) chama `acquireClaimLock` no `beforeAll` e `releaseClaimLock` no `afterAll` (`src/lib/notifications/claim-lock.test-util.ts`), como `src/lib/scr/queries.integration.test.ts`.
- Teste que cria versão nova de `legal_documents` faz isso numa transação do dono que termina em `rollback` (a versão vigente é global e os arquivos rodam em paralelo). Nunca faça commit de versão nova em teste.
- Teste de cadastro usa um IP aleatório por caso (`10.<n>.<n>.<n>`): o limite por IP é global.
- Funções `SECURITY DEFINER` seguem a 009 e a 020: `set search_path = pg_catalog, public`, nomes qualificados com `public.`, `alter function ... owner to auth_profile_lookup`, `revoke all ... from public`, `grant execute` só para `app_runtime` e só nas funções públicas. Funções internas não têm `grant`.
- Nunca guarde token ou código cru fora de `notifications.params` (o worker do M4 apaga). O desafio guarda só o SHA-256.
- Nunca grave nem logue documento, e-mail sem máscara, telefone sem máscara, token, código ou hash em auditoria, log ou mensagem de erro. Log da aplicação: só o passo, o nome e o código do erro (modelo de `logFailure` em `src/actions/credits-topup.ts`).
- Auditoria na mesma transação da mudança. As funções da 021 gravam a auditoria direto em `audit_logs` (o cadastro não tem sessão).
- Server Actions: zod `safeParse` → sessão e permissão (exceto `registerClientAction` e `confirmEmailAction`, que são públicas) → query → `revalidatePath`; retorno `{ error: string | null, id? }`. Queries retornam `{ ok: false, reason }` para conflito de negócio; motivo desconhecido lança erro.
- `disableSignUp` continua `true`. Não mude `src/lib/auth/config.ts` nem `src/lib/auth/server.ts`.
- Identificadores em inglês. UI, erros e comentários em pt-BR.
- **Gate da task:** os testes do escopo da task passam. `npm run lint && npm run type-check && npm run test` passam no fim da última onda.
- Implementadores: agente especialista com `model: "sonnet"`. Nunca `opus`.
- Commits: um por task, Conventional Commits, `Closes #n` no corpo quando a task fecha a issue, linha final `Co-Authored-By` conforme o lembrete da sessão. Rode `git rev-parse --short HEAD` antes e registre o hash. `git add` só dos `Files:` da task.

## Decisões deste plano que completam a spec

1. **O hash sai do SQL.** O servidor gera o segredo cru (token ou código) e o passa para a função SQL, que calcula o SHA-256 com `account_secret_hash`. A notificação precisa do segredo cru na mesma transação; passar segredo e hash separados deixaria os dois divergirem. O segredo cru nunca vai para `verification_challenges`.
2. **Limite por tentativa, não por sucesso.** `client_register_attempts` conta toda chamada de `register_client`. Contar só a auditoria `client.register` deixaria sem limite as respostas `email_in_use` e `document_in_use`, que são as que enumeram.
3. **Login depois do cadastro no navegador.** `registerClientAction` devolve `{ error: null }`; o formulário chama `authClient.signIn.email({ email, password, callbackURL: "/portal" })`. Sem caminho novo de cookie no servidor. Falha no login (ex.: 429) leva para `/login`.
4. **Confirmação de e-mail por POST.** A página do link mostra um botão; o clique chama `confirmEmailAction`. Um leitor de link do provedor de e-mail não consome o token.
5. **`/portal/termos` num grupo de rota próprio**, `src/app/(portal-onboarding)/`, com layout que exige `client` e manda para `/portal` quem já aceitou. O layout de `(portal)` redireciona para lá sem laço.
6. **Template de autenticação da Meta.** `phone_verification` leva o código no corpo (`{{1}}`) e no botão "copiar código" (componente `button`, `sub_type: "url"`, `index: "0"`). `buildWhatsappPayload` acrescenta o botão só para as chaves de `AUTH_CODE_TEMPLATE_KEYS = ["phone_verification"]`.
7. **Trigger em vez de grant por coluna.** `app_runtime` tem UPDATE em toda a tabela `profiles` (004). Trocar por grant por coluna mexeria em todos os fluxos da equipe. O trigger `protect_profile_contact` recusa só a escrita de `app_runtime` em `phone_e164`, `phone_verified_at` e `notification_channel`.

## Review Focus

1. Cadastro atômico e D3 — Task 1: `register_client creates every row in one transaction`, `email challenge failure rolls back the whole registration`, `document already in the bureau is refused with and without client_profile_id`, `same document registers in another bureau with another email`.
2. Abuso do cadastro e do reenvio — Task 1: `11th attempt from the same ip in one hour is rate_limited`, `resend respects 60 s cooldown and 5 per hour`.
3. Segredos — Task 1: `challenge stores only the sha256 of the secret`, `app_runtime cannot read verification_challenges`; Task 3: `audit, logs and errors carry no document, raw email, raw phone, token or code`; Task 2: `fake driver never logs in production`.
4. Código de telefone — Task 1: `fifth wrong code consumes the challenge`, `expired code is refused`, `new phone clears verification and resets channel to email`.
5. Colunas de segurança em `profiles` — Task 1 (RLS): `app_runtime cannot write phone_e164, phone_verified_at or notification_channel`.
6. Notificação fora do staff — Task 1: `enqueue_system_notification and helpers are not executable by app_runtime`, `register_client enqueues email_verification with the token url and no document`.
7. Bloqueio de compra (D2) — Task 3: `topup is refused while the email is not verified`, `unverified phone does not block topup`.
8. Termos versionados — Task 1: `new version requires a new acceptance`, `acceptance of an outdated version is refused`; Task 3: `getClientAccountStatus reports termsAccepted per current version`.
9. IP do cliente — Task 2: `requestMeta drops an invalid ip and truncates user agent`.

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `db/migrations/021_client_accounts.sql` | slugs, colunas, tabelas, trigger, funções, RLS, grants, seeds | 1 |
| `src/lib/account/account.integration.test.ts` | regras das funções SQL | 1 |
| `src/lib/db/rls.integration.test.ts` | casos de RLS e grant da 021 | 1 |
| `src/lib/validators/{register,account}.ts` (+ testes) | schemas zod do cadastro e da conta | 2 |
| `src/lib/account/{secrets,request-meta}.ts` (+ testes) | token, código, IP e user-agent | 2 |
| `src/middleware.ts`, `src/middleware.test.ts` | rotas públicas novas | 2 |
| `src/lib/notifications/render.ts`, `channels/whatsapp.ts` (+ testes) | botão do código; log do driver fake | 2 |
| `src/lib/account/queries.ts` (+ teste de integração) | chamadas às funções SQL, estado da conta, textos legais | 3 |
| `src/actions/register.ts` (+ testes) | cadastro e confirmação de e-mail | 3 |
| `src/actions/account.ts` (+ teste) | reenvio, telefone, termos, canal | 3 |
| `src/actions/credits-topup.ts` (+ teste) | bloqueio sem e-mail confirmado | 3 |
| `src/app/b/[slug]/page.tsx`, `src/app/b/[slug]/cadastro/page.tsx`, `src/components/register/*` | cadastro | 4 |
| `src/app/cadastro/confirmar-email/page.tsx` | confirmação de e-mail | 4 |
| `src/app/{termos,privacidade}/page.tsx`, `src/components/legal/*`, `src/app/(portal-onboarding)/**` | textos legais e aceite | 4 |
| `src/app/(portal)/layout.tsx`, `src/app/(portal)/portal/perfil/page.tsx`, `src/components/account/*`, `src/app/(portal)/portal/credits/page.tsx` | portal: termos, banner, perfil, aviso de compra | 5 |
| `docs/architecture.md`, `PRODUCT.md`, `docs/operations/notifications.md` | documentação do M5 | 6 |

**Arquivos compartilhados e dono único:** `src/middleware.ts` → Task 2. `src/lib/notifications/render.ts` e `channels/whatsapp.ts` → Task 2. `src/lib/account/queries.ts` → Task 3 (as Tasks 4 e 5 só importam). `src/lib/db/permissions.ts`, `src/lib/config.ts` e `src/test/seed.ts`: nenhuma task edita (o cliente já tem `portal:*` e `credits:*`).

## Ondas

| Onda | Tasks | Por quê |
|---|---|---|
| 1 | 1, 2 | schema; código puro e de borda. Contratos fixados neste plano; arquivos disjuntos |
| 2 | 3, 6 | usa as funções da Task 1 e os validadores e segredos da Task 2 |
| 3 | 4, 5 | usam as ações e queries da Task 3; arquivos disjuntos |

Review uma vez, no fim, sobre o diff inteiro: `code-reviewer` e `security-reviewer` (cadastro público, token e código, RLS, IP no log de consentimento). Um review final em `opus` é permitido por tocar segurança; nunca como implementador.

---

### Task 1: Migration 021 — contas de cliente

**Agent:** `database-architect` · `model: "sonnet"`
**Files:**
- Create: `db/migrations/021_client_accounts.sql`
- Create: `src/lib/account/account.integration.test.ts`
- Modify: `src/lib/db/rls.integration.test.ts` (novo `describe("client accounts (021)")` no fim)

**Depends-on:** none

**Interfaces:**
- Produces (funções com `EXECUTE` para `app_runtime`; todas `returns table (ok boolean, reason text)` salvo indicação):
  - `register_client(p_slug text, p_type text, p_name text, p_document_digits text, p_email text, p_phone_e164 text, p_password_hash text, p_terms_version integer, p_privacy_version integer, p_ip inet, p_user_agent text, p_email_token text, p_site_url text) returns table (ok boolean, reason text, user_id uuid)` — reasons `rate_limited | invalid_input | bureau_not_found | outdated_terms | document_in_use | email_in_use`.
  - `confirm_email_verification(p_token text)` — reasons `invalid | expired`.
  - `request_email_verification(p_user_id uuid, p_token text, p_site_url text)` — reasons `not_allowed | already_verified | invalid_input | cooldown | too_many`.
  - `request_phone_verification(p_user_id uuid, p_phone_e164 text, p_code text)` — reasons `not_allowed | invalid_input | already_verified | cooldown | too_many`.
  - `confirm_phone_verification(p_user_id uuid, p_code text)` — reasons `not_allowed | invalid | expired | too_many_attempts`.
  - `accept_legal_documents(p_user_id uuid, p_terms_version integer, p_privacy_version integer, p_ip inet, p_user_agent text)` — reasons `not_allowed | outdated`.
  - `set_notification_channel(p_user_id uuid, p_channel text)` — reasons `not_allowed | invalid_input | phone_not_verified`.
- Produces (internas, sem grant para `app_runtime`): `account_secret_hash(text)`, `account_mask_recipient(text, text)`, `legal_current_version(text)`, `enqueue_system_notification(uuid, uuid, text, text, text, jsonb, text, text) returns uuid`, `account_issue_email_challenge(uuid, text, text) returns text`.
- Consumes: `notification_templates`, `notifications`, `notification_events`, `notification_recipient_hash` (020); `append_only_guard()` e o trigger `profiles_create_client_wallet` (015); `app_*` (004).

**Schema (forma exata):**

```sql
-- M5: contas de cliente. A 001-020 já foram aplicadas e não mudam.
-- Cadastro público (register_client), confirmação de e-mail e de telefone (verification_challenges: só o hash),
-- aceite versionado (legal_documents, legal_acceptances) e canal de notificação (profiles).
-- Toda escrita passa por função SECURITY DEFINER com dono auth_profile_lookup, sob as políticas *_gateway abaixo.
-- app_runtime executa só as funções públicas; enqueue_system_notification e os auxiliares não têm grant.

-- Rotas novas de primeiro nível ficam fora dos slugs, como as outras.
alter table bureaus drop constraint bureaus_slug_not_reserved;
alter table bureaus add constraint bureaus_slug_not_reserved check (slug not in (
  'admin', 'api', 'app', 'auth', 'b', 'dashboard', 'login', 'logout', 'mfa',
  'portal', 'autorizacao-scr', 'superadmin', 'settings', 'reset-password',
  'update-password', 'change-password', 'static', 'www',
  'cadastro', 'termos', 'privacidade'));

alter table profiles
  add column phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column phone_verified_at timestamptz,
  add column notification_channel text not null default 'email' check (notification_channel in ('email', 'whatsapp')),
  add constraint profiles_phone_verified_needs_phone check (phone_verified_at is null or phone_e164 is not null),
  add constraint profiles_whatsapp_needs_verified_phone check (notification_channel = 'email' or phone_verified_at is not null);

-- app_runtime tem UPDATE em toda a tabela (004): estas três colunas mudam só pelas funções da 021.
create function protect_profile_contact()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user <> 'app_runtime' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.phone_e164 is not null or new.phone_verified_at is not null or new.notification_channel <> 'email' then
      raise exception 'profile contact fields change only through the account functions' using errcode = '42501';
    end if;
  elsif row(old.phone_e164, old.phone_verified_at, old.notification_channel)
        is distinct from row(new.phone_e164, new.phone_verified_at, new.notification_channel) then
    raise exception 'profile contact fields change only through the account functions' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger protect_profile_contact before insert or update on profiles
  for each row execute function protect_profile_contact();

create table legal_documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('terms', 'privacy')),
  version integer not null check (version > 0),
  title text not null check (length(title) between 1 and 200),
  body_md text not null check (length(body_md) between 1 and 200000),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (kind, version)
);
create trigger legal_documents_immutable before update or delete on legal_documents
  for each row execute function append_only_guard();

create table legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  document_id uuid not null references legal_documents(id),
  accepted_at timestamptz not null default now(),
  ip inet,
  user_agent text check (user_agent is null or length(user_agent) <= 512),
  unique (profile_id, document_id)
);
create trigger legal_acceptances_immutable before update or delete on legal_acceptances
  for each row execute function append_only_guard();

create table verification_challenges (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id),
  kind text not null check (kind in ('email', 'phone')),
  -- O e-mail ou o telefone do desafio: a confirmação só vale se ainda for o atual.
  target text not null check (length(target) between 3 and 320),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index verification_challenges_profile_kind_created_idx
  on verification_challenges (profile_id, kind, created_at desc);
-- Token de e-mail tem 256 bits: único. Código de telefone (6 dígitos) repete entre clientes: sem índice único.
create unique index verification_challenges_email_hash_uidx
  on verification_challenges (code_hash) where kind = 'email';

create table client_register_attempts (
  id bigint generated always as identity primary key,
  ip inet,
  created_at timestamptz not null default now()
);
create index client_register_attempts_ip_created_at_idx on client_register_attempts (ip, created_at);
create index client_register_attempts_created_at_idx on client_register_attempts (created_at);
```

**Funções internas (forma exata):**

```sql
create function account_secret_hash(p text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

-- Mesma máscara de src/lib/notifications/recipient.ts (maskRecipient).
create function account_mask_recipient(p_channel text, p_recipient text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_channel = 'email' then left(split_part(p_recipient, '@', 1), 1) || '***@' || split_part(p_recipient, '@', 2)
    when p_recipient like '+55%' then '+55' || repeat('*', greatest(length(p_recipient) - 7, 0)) || right(p_recipient, 4)
    else '+' || repeat('*', greatest(length(p_recipient) - 5, 0)) || right(p_recipient, 4)
  end
$$;

create function legal_current_version(p_kind text)
returns integer
language sql
stable
set search_path = pg_catalog, public
as $$
  select max(d.version) from public.legal_documents d where d.kind = p_kind and d.published_at <= now()
$$;

-- Enfileira sem staff (cadastro anônimo, cliente). Mesmas regras da enqueue_notification (020), mas lança erro:
-- o chamador é uma função da 021 e uma falha aqui desfaz a transação inteira.
create function enqueue_system_notification(
  p_bureau_id uuid,
  p_created_by uuid,
  p_template_key text,
  p_channel text,
  p_recipient text,
  p_params jsonb,
  p_idempotency_key text,
  p_reference text
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_tpl public.notification_templates;
  v_id uuid;
begin
  select * into v_tpl from public.notification_templates
   where key = p_template_key and channel = p_channel and status = 'active';
  if not found then
    raise exception 'notification template % (%) not found', p_template_key, p_channel using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_params) is distinct from 'object'
     or exists (select 1 from jsonb_each(p_params) e where jsonb_typeof(e.value) <> 'string')
     or (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_params) k)
        <> (select coalesce(array_agg(x order by x), '{}') from unnest(v_tpl.params) x) then
    raise exception 'invalid params for template %', p_template_key using errcode = '22023';
  end if;

  insert into public.notifications
    (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params,
     idempotency_key, reference, created_by)
  values
    (p_bureau_id, v_tpl.id, p_channel, p_recipient, public.account_mask_recipient(p_channel, p_recipient),
     public.notification_recipient_hash(p_recipient), p_params, p_idempotency_key, p_reference, p_created_by)
  returning id into v_id;

  insert into public.notification_events (notification_id, bureau_id, kind) values (v_id, p_bureau_id, 'queued');
  return v_id;
end
$$;

-- Desafio de e-mail + notificação + auditoria. null = criado; senão o motivo.
create function account_issue_email_challenge(p_profile_id uuid, p_token text, p_site_url text)
returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_p record;
  v_id uuid;
begin
  select p.bureau_id, p.full_name, u.email, u.email_verified
    into v_p
    from public.profiles p
    join public."user" u on u.id = p.auth_user_id
   where p.id = p_profile_id and p.role = 'client'
   for update of p;
  if not found then
    return 'not_allowed';
  end if;
  if v_p.email_verified then
    return 'already_verified';
  end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$'
     or p_site_url is null or p_site_url !~ '^https?://[^\s?#]+$' then
    return 'invalid_input';
  end if;
  if exists (select 1 from public.verification_challenges c
              where c.profile_id = p_profile_id and c.kind = 'email'
                and c.created_at > now() - interval '60 seconds') then
    return 'cooldown';
  end if;
  if (select count(*) from public.verification_challenges c
       where c.profile_id = p_profile_id and c.kind = 'email'
         and c.created_at > now() - interval '1 hour') >= 5 then
    return 'too_many';
  end if;

  -- Pedido novo invalida o link anterior.
  update public.verification_challenges set consumed_at = now()
   where profile_id = p_profile_id and kind = 'email' and consumed_at is null;
  insert into public.verification_challenges (profile_id, kind, target, code_hash, expires_at)
  values (p_profile_id, 'email', lower(v_p.email), public.account_secret_hash(p_token), now() + interval '24 hours')
  returning id into v_id;

  perform public.enqueue_system_notification(
    v_p.bureau_id, p_profile_id, 'email_verification', 'email', lower(v_p.email),
    jsonb_build_object('clientName', v_p.full_name,
                       'url', rtrim(p_site_url, '/') || '/cadastro/confirmar-email?token=' || p_token),
    'email_verification:' || v_id, 'profile:' || p_profile_id);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_p.bureau_id, p_profile_id, 'client.email_verification_requested', 'profiles', p_profile_id, '{}');
  return null;
end
$$;
```

**Cadastro (forma exata):**

```sql
create function register_client(
  p_slug text,
  p_type text,
  p_name text,
  p_document_digits text,
  p_email text,
  p_phone_e164 text,
  p_password_hash text,
  p_terms_version integer,
  p_privacy_version integer,
  p_ip inet,
  p_user_agent text,
  p_email_token text,
  p_site_url text
)
returns table (ok boolean, reason text, user_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_bureau uuid;
  v_email text := lower(btrim(p_email));
  v_name text := btrim(p_name);
  v_id uuid := gen_random_uuid();
  v_reason text;
begin
  -- LimitByIp: toda chamada conta, com sucesso ou não. A linha fica mesmo com ok = false.
  perform pg_advisory_xact_lock(hashtextextended('client_register:' || coalesce(host(p_ip), '-'), 0));
  delete from public.client_register_attempts where created_at < now() - interval '1 day';
  if (select count(*) from public.client_register_attempts a
       where a.ip is not distinct from p_ip and a.created_at > now() - interval '1 hour') >= 10 then
    return query select false, 'rate_limited'::text, null::uuid;
    return;
  end if;
  insert into public.client_register_attempts (ip) values (p_ip);

  if p_type is null or p_type not in ('PF', 'PJ')
     or p_document_digits is null
     or p_document_digits !~ (case p_type when 'PF' then '^[0-9]{11}$' else '^[0-9]{14}$' end)
     or v_name is null or length(v_name) not between 2 and 120
     or v_email is null or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$'
     or p_password_hash is null or length(p_password_hash) < 20
     or (p_user_agent is not null and length(p_user_agent) > 512) then
    return query select false, 'invalid_input'::text, null::uuid;
    return;
  end if;

  select b.id into v_bureau from public.bureaus b where b.slug = p_slug and b.status = 'active';
  if not found then
    return query select false, 'bureau_not_found'::text, null::uuid;
    return;
  end if;

  if p_terms_version is distinct from public.legal_current_version('terms')
     or p_privacy_version is distinct from public.legal_current_version('privacy') then
    return query select false, 'outdated_terms'::text, null::uuid;
    return;
  end if;

  -- D3: Titular do mesmo documento no Bureau, ligado ou não a uma conta. O operador liga pelo convite.
  perform pg_advisory_xact_lock(hashtextextended('holder_document:' || v_bureau::text || ':' || p_document_digits, 0));
  if exists (select 1 from public.holders h where h.bureau_id = v_bureau and h.document_digits = p_document_digits) then
    return query select false, 'document_in_use'::text, null::uuid;
    return;
  end if;

  insert into public."user" (id, name, email, email_verified)
  values (v_id::text, v_name, v_email, false)
  on conflict ((lower(email))) do nothing;
  if not found then
    return query select false, 'email_in_use'::text, null::uuid;
    return;
  end if;

  insert into public.account (id, issuer, account_id, provider_id, user_id, password, updated_at)
  values (gen_random_uuid()::text, 'local:credential', v_id::text, 'credential', v_id::text, p_password_hash, now());
  -- O trigger profiles_create_client_wallet (015) cria a carteira zerada.
  insert into public.profiles (id, auth_user_id, full_name, email, role, bureau_id, phone_e164)
  values (v_id, v_id::text, v_name, v_email, 'client', v_bureau, p_phone_e164);
  insert into public.holders (bureau_id, type, name, document, email, phone, client_profile_id, created_by)
  values (v_bureau, p_type::public.query_type, v_name, p_document_digits, v_email, p_phone_e164, v_id, v_id);
  insert into public.legal_acceptances (profile_id, document_id, ip, user_agent)
  select v_id, d.id, p_ip, p_user_agent
    from public.legal_documents d
   where (d.kind = 'terms' and d.version = p_terms_version)
      or (d.kind = 'privacy' and d.version = p_privacy_version);
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata, ip_address, user_agent)
  values (v_bureau, v_id, 'client.register', 'profiles', v_id, jsonb_build_object('type', p_type), p_ip, p_user_agent);

  v_reason := public.account_issue_email_challenge(v_id, p_email_token, p_site_url);
  if v_reason is not null then
    raise exception 'email challenge failed: %', v_reason using errcode = '22023';
  end if;
  return query select true, null::text, v_id;
end
$$;
```

**Confirmação de e-mail (forma exata):**

```sql
create function confirm_email_verification(p_token text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_c record;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    return query select false, 'invalid'::text;
    return;
  end if;
  select c.id, c.profile_id, c.target, c.expires_at, c.consumed_at, p.bureau_id, p.auth_user_id,
         u.email, u.email_verified
    into v_c
    from public.verification_challenges c
    join public.profiles p on p.id = c.profile_id
    join public."user" u on u.id = p.auth_user_id
   where c.kind = 'email' and c.code_hash = public.account_secret_hash(p_token)
   for update of c;
  if not found then
    return query select false, 'invalid'::text;
    return;
  end if;
  if v_c.consumed_at is not null then
    -- Segundo clique no mesmo link: sucesso só se o e-mail já está confirmado.
    return query select v_c.email_verified, case when v_c.email_verified then null else 'invalid' end::text;
    return;
  end if;
  if v_c.expires_at <= now() then
    return query select false, 'expired'::text;
    return;
  end if;
  if lower(v_c.email) <> v_c.target then
    return query select false, 'invalid'::text;
    return;
  end if;

  update public."user" set email_verified = true, updated_at = now() where id = v_c.auth_user_id;
  update public.verification_challenges set consumed_at = now() where id = v_c.id;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_c.bureau_id, v_c.profile_id, 'client.email_verified', 'profiles', v_c.profile_id, '{}');
  return query select true, null::text;
end
$$;
```

**Código de telefone (forma exata):**

```sql
create function confirm_phone_verification(p_user_id uuid, p_code text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_c record;
begin
  if not public.app_context_present() or public.app_user_role() is distinct from 'client'
     or public.app_user_id() is distinct from p_user_id then
    return query select false, 'not_allowed'::text;
    return;
  end if;
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    return query select false, 'invalid'::text;
    return;
  end if;
  select c.id, c.target, c.code_hash, c.attempts, c.max_attempts, c.expires_at, p.bureau_id, p.phone_e164
    into v_c
    from public.verification_challenges c
    join public.profiles p on p.id = c.profile_id
   where c.profile_id = p_user_id and c.kind = 'phone' and c.consumed_at is null
     and p.bureau_id = public.app_bureau_id()
   order by c.created_at desc
   limit 1
   for update of c;
  if not found then
    return query select false, 'invalid'::text;
    return;
  end if;
  if v_c.expires_at <= now() then
    return query select false, 'expired'::text;
    return;
  end if;
  if v_c.code_hash <> public.account_secret_hash(p_code) or v_c.target is distinct from v_c.phone_e164 then
    -- A tentativa conta mesmo com erro: a função retorna normalmente e a transação faz commit.
    update public.verification_challenges
       set attempts = attempts + 1,
           consumed_at = case when attempts + 1 >= max_attempts then now() end
     where id = v_c.id;
    return query select false,
      case when v_c.attempts + 1 >= v_c.max_attempts then 'too_many_attempts' else 'invalid' end::text;
    return;
  end if;

  update public.verification_challenges set attempts = attempts + 1, consumed_at = now() where id = v_c.id;
  update public.profiles set phone_verified_at = now() where id = p_user_id;
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_c.bureau_id, p_user_id, 'client.phone_verified', 'profiles', p_user_id, '{}');
  return query select true, null::text;
end
$$;
```

**Contrato das demais funções públicas** (definer, mesmo cabeçalho e mesma checagem de contexto de `confirm_phone_verification`; `#variable_conflict use_column`):
- **ClientContext** (todas menos `register_client` e `confirm_email_verification`): `app_context_present()`, `app_user_role() = 'client'` e `app_user_id() = p_user_id`; senão `not_allowed`. O perfil é lido com `p.id = p_user_id and p.role = 'client' and p.bureau_id = app_bureau_id()`; sem linha: `not_allowed`.
- `request_email_verification(p_user_id, p_token, p_site_url)`: ClientContext; `v_reason := account_issue_email_challenge(p_user_id, p_token, p_site_url)`; devolve `(v_reason is null, v_reason)`.
- `request_phone_verification(p_user_id, p_phone_e164, p_code)`, na ordem:
  1. ClientContext.
  2. Telefone fora de `^\+[1-9][0-9]{7,14}$` ou código fora de `^[0-9]{6}$`: `invalid_input`.
  3. Lê o perfil `for update`. `v_changed := phone_e164 is distinct from p_phone_e164`. Telefone igual e já confirmado: `already_verified`.
  4. Desafio `phone` do perfil nos últimos 60 s: `cooldown`. 5 ou mais na última hora: `too_many`. (Antes de mudar o telefone: pedido recusado não muda nada.)
  5. Se `v_changed`: `update profiles set phone_e164 = p_phone_e164, phone_verified_at = null, notification_channel = 'email'`.
  6. Consome os desafios `phone` abertos do perfil; insere o novo (`target = p_phone_e164`, `code_hash = account_secret_hash(p_code)`, `expires_at = now() + interval '10 minutes'`).
  7. `enqueue_system_notification(bureau, p_user_id, 'phone_verification', 'whatsapp', p_phone_e164, jsonb_build_object('code', p_code), 'phone_verification:' || <id do desafio>, 'profile:' || p_user_id)`.
  8. Auditoria `client.phone_verification_requested`, `metadata = jsonb_build_object('phoneChanged', v_changed)`.
- `accept_legal_documents(p_user_id, p_terms_version, p_privacy_version, p_ip, p_user_agent)`: ClientContext; versões diferentes de `legal_current_version('terms')` ou `('privacy')`: `outdated`. Insere os dois aceites (`user_agent = left(p_user_agent, 512)`) com `on conflict (profile_id, document_id) do nothing`. Com linha nova (`get diagnostics ... row_count > 0`): auditoria `client.legal_accepted` com `metadata = {termsVersion, privacyVersion}`, `ip_address` e `user_agent`. Sem linha nova: só `ok`.
- `set_notification_channel(p_user_id, p_channel)`: ClientContext; canal fora de `email | whatsapp`: `invalid_input`. Lê o perfil `for update`. `whatsapp` sem `phone_verified_at`: `phone_not_verified`. Canal igual ao atual: `ok` sem auditoria. Senão atualiza e grava `client.notification_channel_set` com `metadata = {channel}`.

**Donos, grants, RLS (forma exata):**

```sql
alter table legal_documents owner to schema_owner;
alter table legal_acceptances owner to schema_owner;
alter table verification_challenges owner to schema_owner;
alter table client_register_attempts owner to schema_owner;
alter function protect_profile_contact() owner to schema_owner;
alter function account_secret_hash(text) owner to schema_owner;
alter function account_mask_recipient(text, text) owner to schema_owner;
alter function legal_current_version(text) owner to auth_profile_lookup;
alter function enqueue_system_notification(uuid, uuid, text, text, text, jsonb, text, text) owner to auth_profile_lookup;
alter function account_issue_email_challenge(uuid, text, text) owner to auth_profile_lookup;
alter function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text) owner to auth_profile_lookup;
alter function confirm_email_verification(text) owner to auth_profile_lookup;
alter function request_email_verification(uuid, text, text) owner to auth_profile_lookup;
alter function request_phone_verification(uuid, text, text) owner to auth_profile_lookup;
alter function confirm_phone_verification(uuid, text) owner to auth_profile_lookup;
alter function accept_legal_documents(uuid, integer, integer, inet, text) owner to auth_profile_lookup;
alter function set_notification_channel(uuid, text) owner to auth_profile_lookup;

-- revoke all ... from public em TODAS as funções acima (uma linha por função, como a 020).
grant execute on function account_secret_hash(text) to auth_profile_lookup;
grant execute on function account_mask_recipient(text, text) to auth_profile_lookup;
grant execute on function register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text) to app_runtime;
grant execute on function confirm_email_verification(text) to app_runtime;
grant execute on function request_email_verification(uuid, text, text) to app_runtime;
grant execute on function request_phone_verification(uuid, text, text) to app_runtime;
grant execute on function confirm_phone_verification(uuid, text) to app_runtime;
grant execute on function accept_legal_documents(uuid, integer, integer, inet, text) to app_runtime;
grant execute on function set_notification_channel(uuid, text) to app_runtime;

alter table legal_documents enable row level security;
alter table legal_documents force row level security;
alter table legal_acceptances enable row level security;
alter table legal_acceptances force row level security;
alter table verification_challenges enable row level security;
alter table verification_challenges force row level security;
alter table client_register_attempts enable row level security;
alter table client_register_attempts force row level security;

revoke all on legal_documents, legal_acceptances, verification_challenges, client_register_attempts
  from public, app_runtime, app_webhook, app_dispatch, auth_profile_lookup;
-- Texto público: as páginas /termos e /privacidade leem sem sessão.
grant select on legal_documents to app_runtime;
grant select on legal_acceptances to app_runtime;
grant select on legal_documents, legal_acceptances, verification_challenges, client_register_attempts to backup_reader;

create policy legal_documents_select on legal_documents for select using (true);
create policy legal_acceptances_select_own on legal_acceptances for select
  using (app_context_present() and profile_id = app_user_id());

-- Dono das funções: só o que elas fazem, e só sob as políticas abaixo.
grant select on legal_documents to auth_profile_lookup;
grant select, insert on legal_acceptances to auth_profile_lookup;
grant select, insert, update (attempts, consumed_at) on verification_challenges to auth_profile_lookup;
grant select, insert, delete on client_register_attempts to auth_profile_lookup;
grant select (id, email, email_verified), insert (id, name, email, email_verified),
  update (email_verified, updated_at) on public."user" to auth_profile_lookup;
grant select (full_name, email, phone_e164, phone_verified_at, notification_channel),
  insert (id, auth_user_id, full_name, email, role, bureau_id, phone_e164),
  update (phone_e164, phone_verified_at, notification_channel) on public.profiles to auth_profile_lookup;
grant select (document_digits),
  insert (bureau_id, type, name, document, email, phone, client_profile_id, created_by) on public.holders to auth_profile_lookup;
grant insert (ip_address, user_agent) on public.audit_logs to auth_profile_lookup;

create policy legal_acceptances_gateway_select on legal_acceptances for select to auth_profile_lookup using (true);
create policy legal_acceptances_gateway_insert on legal_acceptances for insert to auth_profile_lookup with check (true);
create policy verification_challenges_gateway_select on verification_challenges for select to auth_profile_lookup using (true);
create policy verification_challenges_gateway_insert on verification_challenges for insert to auth_profile_lookup with check (true);
create policy verification_challenges_gateway_update on verification_challenges for update to auth_profile_lookup
  using (true) with check (true);
create policy client_register_attempts_gateway_select on client_register_attempts for select to auth_profile_lookup using (true);
create policy client_register_attempts_gateway_insert on client_register_attempts for insert to auth_profile_lookup with check (true);
create policy client_register_attempts_gateway_delete on client_register_attempts for delete to auth_profile_lookup using (true);
create policy profiles_gateway_insert on profiles for insert to auth_profile_lookup
  with check (role = 'client' and bureau_id is not null and not must_change_password);
-- profiles_gateway_update (009) cobre só a equipe; admin_set_credentials confere o papel no próprio SQL.
create policy profiles_gateway_update_client on profiles for update to auth_profile_lookup
  using (role = 'client') with check (role = 'client');
create policy holders_gateway_insert on holders for insert to auth_profile_lookup
  with check (client_profile_id is not null and created_by = client_profile_id);
-- Auditoria das funções da 021: só estas ações, só sobre o próprio perfil client do Bureau.
create policy audit_logs_client_account_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('client.register', 'client.email_verification_requested', 'client.email_verified',
             'client.phone_verification_requested', 'client.phone_verified', 'client.legal_accepted',
             'client.notification_channel_set')
  and table_name = 'profiles'
  and record_id = user_id
  and support_session_id is null
  and exists (
    select 1 from profiles p
     where p.id = audit_logs.user_id and p.role = 'client' and p.bureau_id = audit_logs.bureau_id)
);
```

**Seeds:**
- `legal_documents`: `('terms', 1, 'Termos de Uso', <md>)` e `('privacy', 1, 'Política de Privacidade', <md>)`. Corpo em pt-BR, Markdown, com a primeira linha `> **Texto provisório.** Este texto será substituído pela versão aprovada antes da abertura do cadastro ao público.` e seções curtas (objeto, conta, dados tratados, direitos do titular pela LGPD, contato `contato@rainhadocredito.com`). Use `$md$ ... $md$`.
- `notification_templates`, `email_verification`, e-mail, v1, `params = array['clientName', 'url']`: assunto `Confirme seu e-mail — Rainha do Crédito`. HTML com o mesmo cabeçalho, cores e rodapé do seed `scr_authorization` da 020; corpo "Olá, {{clientName}}.", botão "Confirmar e-mail" com `href="{{url}}"`, "O link vale por 24 horas.", "Se você não criou esta conta, ignore este e-mail.". Texto puro com o mesmo conteúdo e `{{url}}`.
- `notification_templates`, `phone_verification`, WhatsApp, v1, `params = array['code']`, `wa_template_name = 'verification_code'`, `wa_language = 'pt_BR'`.

**Testes — `src/lib/account/account.integration.test.ts`** (pool do dono para preparar e conferir; pool `app_runtime` para chamar as funções; `withDbContext(app, client, ...)` para as funções com ClientContext; hash de senha qualquer com 20+ caracteres; `acquireClaimLock`):
- `randomCpf()` devolve o CPF com máscara: passe `onlyDigits(randomCpf())` em `p_document_digits`.
- `register_client creates every row in one transaction`: `"user"` (`email_verified = false`), `account` (`credential`), `profiles` (`client`, `phone_e164`, `notification_channel = 'email'`), `client_wallets` zerada, `holders` (`client_profile_id` = `created_by` = perfil), dois `legal_acceptances` com IP e user-agent, auditoria `client.register` com IP, um desafio `email` e uma notificação `email_verification`.
- `register_client enqueues email_verification with the token url and no document`: `params.url` termina com `/cadastro/confirmar-email?token=<token>`; nenhum valor de `params`, `metadata` ou `recipient_masked` contém o documento.
- `challenge stores only the sha256 of the secret`: `code_hash = encode(sha256(token))` e nenhuma coluna do desafio contém o token.
- `email challenge failure rolls back the whole registration`: `p_site_url = 'ftp://x'` lança erro; nenhuma linha em `"user"` com o e-mail; nenhum Titular com o documento.
- `document already in the bureau is refused with and without client_profile_id` (`seedTenant` traz um Titular ligado; crie outro sem ligação pelo dono).
- `same document registers in another bureau with another email`; o mesmo e-mail em outro Bureau devolve `email_in_use` (também com maiúsculas).
- `bureau_not_found` para slug inexistente e para Bureau `inactive`; `outdated_terms` com versão 0; `invalid_input` para CPF com 10 dígitos, PJ com 11, telefone sem `+`.
- `11th attempt from the same ip in one hour is rate_limited`: 10 chamadas com `invalid_input` e a 11ª recusada; outro IP passa.
- `confirm_email_verification`: confirma e grava auditoria; segundo clique devolve `ok`; token desconhecido e formato errado: `invalid`; token expirado (dono move `expires_at`): `expired`; pedido novo invalida o link anterior (`invalid`).
- `resend respects 60 s cooldown and 5 per hour` (dono recua `created_at` dos desafios para simular o tempo), no e-mail e no telefone; `already_verified` no e-mail confirmado.
- `request_phone_verification`: cria desafio e notificação `phone_verification` com `params = {code}`; `not_allowed` com outro `p_user_id`, com papel `operator` e sem contexto.
- `new phone clears verification and resets channel to email`.
- `confirm_phone_verification`: código certo grava `phone_verified_at` e auditoria; `fifth wrong code consumes the challenge` (4 erros `invalid`, o 5º `too_many_attempts`, depois o código certo é `invalid`); `expired code is refused`; código certo de um desafio cujo telefone mudou é `invalid`.
- `set_notification_channel`: `whatsapp` sem telefone confirmado devolve `phone_not_verified`; com telefone confirmado, grava e audita; repetir o mesmo canal não grava auditoria.
- `accept_legal_documents`: `acceptance of an outdated version is refused`; repetir não duplica linha nem auditoria; `new version requires a new acceptance` (dentro da transação do dono, `legal_current_version('terms') = 2` (chamado como dono, antes do `set local role`); como cliente, `accept_legal_documents(uid, 1, 1, ...)` devolve `outdated` e `getClientAccountStatus` devolve `termsAccepted = false`; `rollback` no fim).
- `audit metadata has no document, raw email, raw phone, token or code` (varre as linhas de auditoria criadas no arquivo).

**Testes — `src/lib/db/rls.integration.test.ts`**, `describe("client accounts (021)")`:
- `app_runtime cannot write phone_e164, phone_verified_at or notification_channel` (como o próprio `client` e como `bureau_admin`; UPDATE e INSERT).
- `app_runtime cannot read verification_challenges or client_register_attempts` e não faz INSERT, UPDATE nem DELETE em nenhuma das quatro tabelas novas.
- `legal_documents are readable without context`; `client reads only own legal_acceptances`; `staff reads zero legal_acceptances`.
- `enqueue_system_notification and helpers are not executable by app_runtime` (`enqueue_system_notification`, `account_issue_email_challenge`, `legal_current_version`, `account_secret_hash`, `account_mask_recipient`).
- `legal_documents and legal_acceptances reject update and delete` (dono incluso: o trigger vale para todos).
- Slug `cadastro`, `termos` e `privacidade` recusados em `bureaus`.

- [ ] Escreva os testes (vermelhos).
- [ ] Escreva a migration e rode `npm run db:reset` com a URL do dono.
- [ ] Rode `npx vitest run src/lib/account/account.integration.test.ts src/lib/db/rls.integration.test.ts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 2: Validadores, segredos, borda e canal WhatsApp

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/validators/register.ts`, `src/lib/validators/register.test.ts`
- Create: `src/lib/validators/account.ts`, `src/lib/validators/account.test.ts`
- Create: `src/lib/account/secrets.ts`, `src/lib/account/secrets.test.ts`
- Create: `src/lib/account/request-meta.ts`, `src/lib/account/request-meta.test.ts`
- Modify: `src/middleware.ts`, `src/middleware.test.ts`
- Modify: `src/lib/notifications/render.ts`, `src/lib/notifications/render.test.ts`
- Modify: `src/lib/notifications/channels/whatsapp.ts`, `src/lib/notifications/channels/whatsapp.test.ts`

**Depends-on:** none

**Interfaces:**
- `src/lib/validators/register.ts` (sem dependência de servidor: o formulário importa; não importe `@/lib/notifications/recipient`, que puxa o nodemailer):

```ts
import { z } from "zod";

import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import { passwordSchema } from "@/lib/validators/password";

export const SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;

export const registerFormSchema = z
  .object({
    slug: z.string().regex(SLUG_PATTERN, "Bureau inválido."),
    type: z.enum(["PF", "PJ"]),
    name: z.string().trim().max(120, "Use no máximo 120 caracteres."),
    document: z.string().trim().min(1, "Documento obrigatório."),
    email: z.string().trim().toLowerCase().max(254).email("E-mail inválido."),
    phone: z.string().trim().min(10, "Informe o celular com DDD.").max(30, "Celular inválido."),
    password: passwordSchema,
    confirm: z.string(),
    // boolean + refine (não z.literal(true)): o formulário começa com false.
    acceptedTerms: z.boolean().refine((v) => v, "Aceite os termos de uso e a política de privacidade."),
    termsVersion: z.number().int().positive(),
    privacyVersion: z.number().int().positive(),
  })
  .superRefine((v, ctx) => {
    // Mesma regra de holderSchema: PF = nome 3+ e CPF válido; PJ = razão social 2+ e CNPJ válido.
    const digits = onlyDigits(v.document);
    if (v.type === "PF") {
      if (v.name.length < 3) ctx.addIssue({ code: "custom", path: ["name"], message: "Informe o nome completo." });
      if (!isValidCPF(digits)) ctx.addIssue({ code: "custom", path: ["document"], message: "CPF inválido." });
    } else {
      if (v.name.length < 2) ctx.addIssue({ code: "custom", path: ["name"], message: "Informe a razão social." });
      if (!isValidCNPJ(digits)) ctx.addIssue({ code: "custom", path: ["document"], message: "CNPJ inválido." });
    }
    if (v.password !== v.confirm) {
      ctx.addIssue({ code: "custom", path: ["confirm"], message: "As senhas não coincidem." });
    }
  });

export type RegisterFormValues = z.input<typeof registerFormSchema>;
export const registerSchema = registerFormSchema.transform((v) => ({ ...v, documentDigits: onlyDigits(v.document) }));
export type RegisterInput = z.output<typeof registerSchema>;
```

  Mensagens do `superRefine`: `"Informe o nome completo."` (PF), `"Informe a razão social."` (PJ), `"CPF inválido."`, `"CNPJ inválido."` (path `["document"]`).
- `src/lib/validators/account.ts`:

```ts
export const phoneRequestSchema = z.object({
  phone: z.string().trim().min(10, "Informe o celular com DDD.").max(30, "Celular inválido."),
});
export const phoneCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Informe o código de 6 dígitos."),
});
export const notificationChannelSchema = z.object({ channel: z.enum(["email", "whatsapp"]) });
export const legalAcceptSchema = z.object({
  termsVersion: z.number().int().positive(),
  privacyVersion: z.number().int().positive(),
});
export const EMAIL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const emailTokenSchema = z.string().regex(EMAIL_TOKEN_PATTERN);
```

- `src/lib/account/secrets.ts`:

```ts
import { randomBytes, randomInt } from "node:crypto";

// 32 bytes = 256 bits; base64url sem padding = 43 caracteres (casa com EMAIL_TOKEN_PATTERN e com a 021).
export function generateEmailToken(): string {
  return randomBytes(32).toString("base64url");
}
export function generatePhoneCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
```

- `src/lib/account/request-meta.ts`: `requestMeta(headers: Pick<Headers, "get">): { ip: string | null; userAgent: string | null }`.
  - IP: primeiro item de `x-forwarded-for`, senão `x-real-ip` (mesma ordem de `confirmScrSelfAuthorization`), com `trim`. Valor que falha `isIP` de `node:net` vira `null` (a coluna é `inet`: lixo no header derrubaria o cadastro).
  - User-agent: `user-agent` cortado em 512 caracteres; vazio vira `null`.
- `src/middleware.ts`: acrescente `"/termos"` e `"/privacidade"` em `publicPaths` e `"/cadastro/"` em `publicPrefixes`.
- `src/lib/notifications/render.ts`:
  - `WhatsappTemplate` passa a incluir `template_key`.
  - `export const AUTH_CODE_TEMPLATE_KEYS: readonly string[] = ["phone_verification"]`.
  - Para template nessa lista, `components` ganha, depois do `body`, `{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: params.code }] }`. Sem `params.code`: `TemplateRenderError`. **Confira o formato do botão "copiar código" de template de autenticação na documentação vigente da Meta** e registre num comentário curto o que conferiu.
  - `TemplateRenderError` vem de `./errors` (`src/lib/notifications/errors.ts`). Atualize as fixtures de `render.test.ts` (linhas ~72–107) com `template_key`.
- `src/lib/notifications/channels/whatsapp.ts`: no ramo `config.driver === "fake"`, antes do `return`, quando `process.env.NODE_ENV !== "production"`: `console.info("[whatsapp:fake]", { template: notification.template_key, to: maskRecipient("whatsapp", notification.recipient), params: notification.params })`. Comentário de uma linha: o driver fake é recusado em produção e o log existe para o desenvolvedor ler o código de verificação.

**Testes (casos mínimos):**
- `registerFormSchema`: PF com CPF válido passa e `registerSchema` devolve `documentDigits` sem máscara; CPF com dígito errado, CNPJ com dígito errado, PF com CNPJ e PJ com CPF → erro no `document`; senhas diferentes → erro no `confirm`; `acceptedTerms: false` → mensagem do aceite; e-mail em maiúsculas sai em minúsculas; slug `../x` recusado; senha com 11 caracteres recusada.
- `account.ts`: código com 5 dígitos, com letra e com espaço no meio recusados; `" 123456 "` passa; canal fora do enum recusado; token com 42 caracteres e com `+` recusado.
- `secrets`: token tem 43 caracteres e casa com `EMAIL_TOKEN_PATTERN`; dois tokens diferem; código casa com `^\d{6}$`; `randomInt` mockado devolvendo 42 dá `"000042"`.
- `requestMeta drops an invalid ip and truncates user agent`: `x-forwarded-for: "203.0.113.7, 10.0.0.1"` → `203.0.113.7`; só `x-real-ip` → ele; `"abc"` → `null`; IPv6 passa; user-agent de 600 caracteres → 512; sem headers → nulos.
- Middleware: `/termos`, `/privacidade`, `/cadastro/confirmar-email`, `/b/reino/cadastro` passam sem cookie; `/termosx`, `/cadastrox`, `/cadastro` (sem barra) redirecionam para `/login`.
- Render: `phone_verification` leva o código no `body` e no `button`; outro template não ganha `button`; sem `code` lança `TemplateRenderError`.
- WhatsApp: `fake driver logs template, masked recipient and params outside production`; `fake driver never logs in production` (`vi.stubEnv("NODE_ENV", "production")`: o canal devolve `channel_not_configured` e `console.info` não é chamado); o número completo nunca aparece no log.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/validators/register.test.ts src/lib/validators/account.test.ts src/lib/account/secrets.test.ts src/lib/account/request-meta.test.ts src/middleware.test.ts src/lib/notifications/render.test.ts src/lib/notifications/channels/whatsapp.test.ts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 3: Queries de conta, ações de cadastro e de conta, bloqueio da recarga

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/account/queries.ts`, `src/lib/account/queries.integration.test.ts`
- Create: `src/actions/register.ts`, `src/actions/register.test.ts`, `src/actions/register.integration.test.ts`
- Create: `src/actions/account.ts`, `src/actions/account.test.ts`
- Modify: `src/actions/credits-topup.ts`, `src/actions/credits-topup.test.ts`

**Depends-on:** 1, 2

**Interfaces:**
- Consumes: funções da Task 1; `registerSchema`, `phoneRequestSchema`, `phoneCodeSchema`, `notificationChannelSchema`, `legalAcceptSchema`, `emailTokenSchema` (Task 2); `generateEmailToken`, `generatePhoneCode`, `requestMeta` (Task 2); `toE164` (`src/lib/notifications/recipient.ts`); `hashPassword` (`better-auth/crypto`); `config.betterAuthUrl`.
- Produces — `src/lib/account/queries.ts`:

```ts
import type { PoolClient } from "pg";

export type RegisterFailure =
  | "rate_limited" | "invalid_input" | "bureau_not_found" | "outdated_terms" | "document_in_use" | "email_in_use";
export type RegisterClientInput = {
  slug: string;
  type: "PF" | "PJ";
  name: string;
  documentDigits: string;
  email: string;
  phoneE164: string;
  passwordHash: string;
  termsVersion: number;
  privacyVersion: number;
  ip: string | null;
  userAgent: string | null;
  emailToken: string;
  siteUrl: string;
};
// Sem sessão: pool, uma chamada (a função SQL é atômica).
export function registerClient(input: RegisterClientInput):
  Promise<{ ok: true; userId: string } | { ok: false; reason: RegisterFailure }>;
// Sem sessão: o token é a credencial.
export function confirmEmailVerification(token: string):
  Promise<{ ok: true } | { ok: false; reason: "invalid" | "expired" }>;

export type LegalKind = "terms" | "privacy";
export type LegalDocument = { kind: LegalKind; version: number; title: string; bodyMd: string; publishedAt: Date };
// Sem sessão (páginas públicas). Lança erro se faltar um dos dois tipos.
export function getCurrentLegalDocuments(): Promise<Record<LegalKind, LegalDocument>>;

export type ClientAccountStatus = {
  emailVerified: boolean;
  phoneE164: string | null;
  phoneVerified: boolean;
  notificationChannel: "email" | "whatsapp";
  termsAccepted: boolean;           // aceitou as versões vigentes dos dois tipos
  documentMasked: string | null;    // CPF ***.456.789-** · CNPJ **.345.678/0001-**
};
export function getClientAccountStatus(client: PoolClient, userId: string): Promise<ClientAccountStatus>;

export type AccountResult<R extends string> = { ok: true } | { ok: false; reason: R };
export function requestEmailVerification(client: PoolClient, userId: string, token: string, siteUrl: string):
  Promise<AccountResult<"not_allowed" | "already_verified" | "invalid_input" | "cooldown" | "too_many">>;
export function requestPhoneVerification(client: PoolClient, userId: string, phoneE164: string, code: string):
  Promise<AccountResult<"not_allowed" | "invalid_input" | "already_verified" | "cooldown" | "too_many">>;
export function confirmPhoneVerification(client: PoolClient, userId: string, code: string):
  Promise<AccountResult<"not_allowed" | "invalid" | "expired" | "too_many_attempts">>;
export function acceptLegalDocuments(client: PoolClient, userId: string,
  input: { termsVersion: number; privacyVersion: number; ip: string | null; userAgent: string | null }):
  Promise<AccountResult<"not_allowed" | "outdated">>;
export function setNotificationChannel(client: PoolClient, userId: string, channel: "email" | "whatsapp"):
  Promise<AccountResult<"not_allowed" | "invalid_input" | "phone_not_verified">>;
```

  - Toda função confere o `reason` contra a lista do seu tipo; motivo fora da lista lança `Error("unexpected <função> reason")`.
  - `registerClient`: `select ok, reason, user_id from register_client($1, ..., $10::inet, $11, $12, $13)`.
  - `getClientAccountStatus` (forma exata; roda com a identidade do cliente, sob RLS):

```sql
select u.email_verified, p.phone_e164, p.phone_verified_at is not null as phone_verified, p.notification_channel,
       (select h.document_digits from holders h where h.client_profile_id = p.id order by h.created_at limit 1)
         as document_digits,
       not exists (
         select 1
           from (select distinct on (d.kind) d.id from legal_documents d
                  where d.published_at <= now() order by d.kind, d.version desc) cur
          where not exists (select 1 from legal_acceptances a where a.profile_id = p.id and a.document_id = cur.id)
       ) as terms_accepted
  from profiles p
  join "user" u on u.id = p.auth_user_id
 where p.id = $1
```

  - Sem linha: lança erro (o layout trata como sessão inválida).
- Produces — `src/actions/register.ts` (`"use server"`, sem sessão):
  - `registerClientAction(values: unknown): Promise<{ error: string | null }>`:
    1. `registerSchema.safeParse` → primeira mensagem do zod.
    2. `toE164(phone)`; `null` → `"Celular inválido. Use DDD e número."`.
    3. `hashPassword(password)`; `requestMeta(headers())`; `generateEmailToken()`.
    4. `registerClient({ ..., siteUrl: config.betterAuthUrl })`.
    5. Mensagens: `rate_limited` → `"Muitas tentativas de cadastro. Tente de novo em uma hora."`; `bureau_not_found` → `"Bureau não encontrado."`; `outdated_terms` → `"Os termos foram atualizados. Recarregue a página e aceite a nova versão."`; `document_in_use` → `"Documento já cadastrado neste Bureau. Peça o acesso ao Bureau."`; `email_in_use` → `"E-mail já cadastrado. Entre com sua senha ou recupere o acesso."`; `invalid_input` → `"Dados inválidos."`; exceção → `logFailure` e `"Não foi possível concluir o cadastro. Tente novamente."`.
  - `confirmEmailAction(token: unknown): Promise<{ error: string | null }>`: `emailTokenSchema.safeParse` (falha = `invalid`) → `confirmEmailVerification`. `invalid` → `"Link inválido ou já usado. Entre no portal e peça um novo e-mail."`; `expired` → `"Link expirado. Entre no portal e peça um novo e-mail."`; exceção → `"Não foi possível confirmar o e-mail. Tente novamente."`.
- Produces — `src/actions/account.ts` (`"use server"`):
  - Helper não exportado `requireClient(): Promise<RequiredSession | null>`: `getRequiredSession()` (erro → `null`), `role === "client"` e `hasPermission(session, "portal:write")`; senão `null` → `"Ação não permitida."`.
  - `resendEmailVerificationAction(): Promise<ActionResult>` → `requestEmailVerification(client, session.userId, generateEmailToken(), config.betterAuthUrl)`.
  - `requestPhoneVerificationAction(values: unknown)` → `phoneRequestSchema` → `toE164` (`null` → `"Celular inválido. Use DDD e número."`) → `requestPhoneVerification(..., generatePhoneCode())` → `revalidatePath("/portal/perfil")`.
  - `confirmPhoneAction(values: unknown)` → `phoneCodeSchema` → `confirmPhoneVerification` → `revalidatePath("/portal/perfil")`.
  - `acceptLegalDocumentsAction(values: unknown)` → `legalAcceptSchema` → `requestMeta(headers())` → `acceptLegalDocuments` → `revalidatePath("/portal", "layout")`.
  - `setNotificationChannelAction(values: unknown)` → `notificationChannelSchema` → `setNotificationChannel` → `revalidatePath("/portal/perfil")`.
  - Todas em `withUserTransaction(session, ...)`; `ActionResult = { error: string | null; id?: string }` local (modelo de `portal.ts`).
  - Mensagens: `cooldown` → `"Aguarde 1 minuto antes de pedir outro envio."`; `too_many` → `"Limite de envios atingido. Tente de novo em uma hora."`; `already_verified` → `"Seu e-mail já está confirmado."` (e-mail) e `"Este telefone já está confirmado."` (telefone); `invalid` → `"Código incorreto."`; `expired` → `"Código expirado. Peça um novo."`; `too_many_attempts` → `"Muitas tentativas. Peça um novo código."`; `phone_not_verified` → `"Confirme o telefone antes de escolher o WhatsApp."`; `outdated` → `"Os termos foram atualizados. Recarregue a página."`; `not_allowed` e `invalid_input` → `"Ação não permitida."`; exceção → `logFailure` e `"Não foi possível concluir. Tente novamente."`.
- Modify — `src/actions/credits-topup.ts`: **EmailGate (D2).** Primeira instrução do callback de `reserveCharge`, antes de `getClientWallet` e `lockClientPixCharges` (assim nenhuma linha PIX é reservada): `if (!(await getClientAccountStatus(client, session.userId)).emailVerified) return { blocked: EMAIL_NOT_VERIFIED };` com `const EMAIL_NOT_VERIFIED = "Confirme seu e-mail antes de comprar créditos.";`. `reserveCharge` devolve `ReserveOutcome = { id, expiresAt } | { blocked: string }`; o chamador já transforma `blocked` em `{ error }`. O Asaas não é chamado. Nada mais muda.

**Testes (casos mínimos):**
- `queries.integration.test.ts` (`acquireClaimLock`): `getClientAccountStatus reports termsAccepted per current version` (cliente de `seedClientProfile` sem aceite → `false`; depois de `accept_legal_documents` → `true`; versão 2 numa transação do dono com `rollback` → `false`); `documentMasked` para PF e PJ; `getCurrentLegalDocuments` sem sessão devolve os dois tipos v1; `registerClient` mapeia `email_in_use` e devolve `userId` no sucesso.
- `register.integration.test.ts` (banco real; `next/headers` mockado com `x-forwarded-for` aleatório e `user-agent`; `acquireClaimLock`): cadastro ponta a ponta grava as linhas e `verifyPassword({ hash, password })` de `better-auth/crypto` aceita a senha da conta; `confirmEmailAction` com o token da notificação (leia `params.url` pelo dono) confirma o e-mail.
- `register.test.ts` (unitário, mocks de `@/lib/account/queries`, `next/headers`, `better-auth/crypto`): cada `reason` vira a mensagem da lista; celular inválido não chama `registerClient`; exceção vira a mensagem genérica; `audit, logs and errors carry no document, raw email, raw phone, token or code` (espione `console.error`); `confirmEmailAction` com token mal formado não chama a query.
- `account.test.ts` (mocks de sessão, permissão, transação e queries): `operator`, `bureau_admin` e superadmin em suporte recebem `"Ação não permitida."`; sessão inválida idem; zod recusa código e canal inválidos sem chamar a query; cada `reason` vira a mensagem da lista; o código gerado vai para `requestPhoneVerification` e nunca para o retorno nem para o log.
- `credits-topup.test.ts`: `topup is refused while the email is not verified` (sem chamada ao Asaas); `unverified phone does not block topup` (`emailVerified: true`, `phoneVerified: false` segue para o Asaas). Ajuste os casos existentes para o mock de `getClientAccountStatus` devolver `emailVerified: true`. Mocke `@/lib/account/queries` (`getClientAccountStatus`); o cliente da transação no teste é `{}`.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/account/queries.integration.test.ts src/actions/register.test.ts src/actions/register.integration.test.ts src/actions/account.test.ts src/actions/credits-topup.test.ts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 4: Telas públicas — cadastro, confirmação de e-mail e textos legais

**Agent:** `frontend-specialist` · `model: "sonnet"`
**Files:**
- Modify: `src/app/b/[slug]/page.tsx`
- Create: `src/app/b/[slug]/cadastro/page.tsx`
- Create: `src/components/register/register-form.tsx`, `src/components/register/confirm-email-button.tsx`
- Create: `src/app/cadastro/confirmar-email/page.tsx`
- Create: `src/app/termos/page.tsx`, `src/app/privacidade/page.tsx`
- Create: `src/components/legal/legal-document.tsx`, `src/components/legal/accept-legal-form.tsx`
- Create: `src/app/(portal-onboarding)/layout.tsx`, `src/app/(portal-onboarding)/portal/termos/page.tsx`

**Depends-on:** 3

**Interfaces:**
- Consumes: `registerClientAction`, `confirmEmailAction` (`src/actions/register.ts`); `acceptLegalDocumentsAction` (`src/actions/account.ts`); `getCurrentLegalDocuments`, `getClientAccountStatus` (`src/lib/account/queries.ts`); `registerFormSchema`, `RegisterFormValues` (Task 2); `getPublicBureau`; `authClient`; `MarkdownReport` (`src/components/shared/markdown-report.tsx`).

**Contrato:**
- Invoque `/ui-ux-pro-max` antes de escrever UI. Siga `src/components/CLAUDE.md`, `src/app/(auth)/login/page.tsx` (cartão centralizado, `react-hook-form` + `zodResolver`, erro do servidor em `text-destructive`) e os elementos nativos de `src/components/settings/create-user-form.tsx` (`select`) e `catalog-form.tsx` (`checkbox`).
- `/b/[slug]`: troque `<p>Cadastro em breve</p>` por `<Link href={`/b/${bureau.slug}/cadastro`}>Criar conta</Link>` com o mesmo estilo do link "Entrar".
- `/b/[slug]/cadastro` (server, `export const dynamic = "force-dynamic"`, `metadata` com o título genérico de `/b/[slug]`): `getPublicBureau(slug)` (nulo → `notFound()`), `getCurrentLegalDocuments()`; renderiza o nome do Bureau e `<RegisterForm slug termsVersion privacyVersion />`.
- `RegisterForm` (`"use client"`): campos tipo (PF/PJ), nome ("Nome completo" / "Razão social" pelo tipo), documento ("CPF" / "CNPJ"), e-mail, celular, senha, confirmação, caixa "Li e aceito os [Termos de Uso](/termos) e a [Política de Privacidade](/privacidade)" (links em nova aba). `zodResolver(registerFormSchema)`; `slug`, `termsVersion`, `privacyVersion` vêm das props. Envio: `registerClientAction(values)`; erro → mostra; sucesso → `authClient.signIn.email({ email, password, callbackURL: "/portal" })`; erro no login → `router.push("/login")`. Botão "Criar conta" / "Criando conta...". Link "Já tenho conta" para `/login`.
- `/cadastro/confirmar-email` (server): lê `searchParams.token`; formato fora de `EMAIL_TOKEN_PATTERN` → mensagem "Link inválido." e link para `/login`; senão `<ConfirmEmailButton token />`.
- `ConfirmEmailButton` (`"use client"`): botão "Confirmar e-mail" → `confirmEmailAction(token)`; sucesso → "E-mail confirmado." e link "Ir para o portal" (`/portal`); erro → a mensagem e link "Entrar" (`/login`).
- `LegalDocumentView` (`src/components/legal/legal-document.tsx`, server): título, "Versão {n} · publicada em {formatDate}", corpo com `MarkdownReport`.
- `/termos` e `/privacidade` (server, `force-dynamic`): `getCurrentLegalDocuments()` → `LegalDocumentView` do tipo.
- `(portal-onboarding)/layout.tsx` (server): `getRequiredSession().catch(redirect(sessionErrorPath(err)))`; `role !== "client"` → `redirect("/")`; `getClientAccountStatus` em `withUserTransaction(session, ...)`; `termsAccepted` → `redirect("/portal")`. Cabeçalho simples com a marca e "Sair" (`signOut`).
- `/portal/termos`: os dois `LegalDocumentView` e `<AcceptLegalForm termsVersion privacyVersion />`.
- `AcceptLegalForm` (`"use client"`): botão "Aceitar e continuar" → `acceptLegalDocumentsAction({ termsVersion, privacyVersion })`; sucesso → `router.replace("/portal")` e `router.refresh()`; erro → mensagem (em `outdated`, `router.refresh()`).
- Textos em pt-BR. Estados de carregamento e erro visíveis; rótulos acessíveis (`Label htmlFor`), erro de campo ligado por `aria-describedby`.

**Testes:** UI de apresentação não leva teste; a validação do formulário está na Task 2 e as regras na Task 1 e 3. Verificação visual: `npm run dev` com `WHATSAPP_DRIVER=fake`; crie uma conta PF e uma PJ num Bureau de dev, confirme o e-mail com o link da notificação (dono: `select params->>'url' from notifications order by created_at desc limit 1`), abra `/termos` e `/privacidade`, e entre com um cliente convidado sem aceite para ver `/portal/termos`. Se não for possível abrir o navegador, diga isso no relatório.

- [ ] Implemente, rode `npm run lint && npm run type-check`.
- [ ] Rode `npm run build` (confirma os dois grupos de rota com `portal/`).
- [ ] Verifique as telas no navegador, ou declare que não verificou.
- [ ] Entregue: lista de `Files changed`.

---

### Task 5: Portal — termos, banner de e-mail, perfil e aviso de compra

**Agent:** `frontend-specialist` · `model: "sonnet"`
**Files:**
- Modify: `src/app/(portal)/layout.tsx`
- Create: `src/app/(portal)/portal/perfil/page.tsx`
- Create: `src/components/account/email-verification-banner.tsx`
- Create: `src/components/account/phone-verification-form.tsx`
- Create: `src/components/account/notification-channel-form.tsx`
- Create: `src/components/account/change-password-form.tsx`
- Create: `src/components/account/revoke-sessions-button.tsx`
- Modify: `src/app/(portal)/portal/credits/page.tsx`

**Depends-on:** 3

**Interfaces:**
- Consumes: `getClientAccountStatus`, `ClientAccountStatus` (`src/lib/account/queries.ts`); `resendEmailVerificationAction`, `requestPhoneVerificationAction`, `confirmPhoneAction`, `setNotificationChannelAction` (`src/actions/account.ts`); `authClient` (`changePassword`, `revokeOtherSessions`); `newPasswordSchema` (`src/lib/validators/password.ts`); `phoneRequestSchema`, `phoneCodeSchema` (Task 2).

**Contrato:**
- Invoque `/ui-ux-pro-max` antes de escrever UI. Siga `src/components/CLAUDE.md` e o layout atual do portal.
- `(portal)/layout.tsx`: depois da checagem de papel, `const status = await withUserTransaction(session, (c) => getClientAccountStatus(c, session.userId))`. **TermsGate:** `!status.termsAccepted` → `redirect("/portal/termos")`. Link "Perfil" (`/portal/perfil`) no topo, ao lado de "Créditos". Com `!status.emailVerified`, `<EmailVerificationBanner />` acima do `main`.
- `EmailVerificationBanner` (`"use client"`): "Confirme seu e-mail para comprar créditos. Enviamos um link para o seu e-mail." e botão "Reenviar e-mail" → `resendEmailVerificationAction()`; mostra "E-mail reenviado." ou a mensagem de erro. `role="status"` no aviso.
- `/portal/perfil` (server, `portal:read`): seções em `Card`:
  - "Dados da conta": nome e e-mail da sessão, documento (`status.documentMasked`).
  - "Telefone": `<PhoneVerificationForm phoneE164 phoneVerified />`.
  - "Notificações": `<NotificationChannelForm channel phoneVerified />`.
  - "Segurança": `<ChangePasswordForm />` e `<RevokeSessionsButton />`.
- `PhoneVerificationForm` (`"use client"`): telefone atual e selo "Confirmado" ou "Não confirmado". Campo celular + "Enviar código" → `requestPhoneVerificationAction({ phone })`; sucesso → mostra o campo do código ("Enviamos um código pelo WhatsApp. Ele vale 10 minutos.") e "Confirmar" → `confirmPhoneAction({ code })`; sucesso → `router.refresh()`. Campo do código com `inputMode="numeric"` e `autoComplete="one-time-code"`.
- `NotificationChannelForm` (`"use client"`): `select` com "E-mail" e "WhatsApp"; "WhatsApp" desabilitado sem telefone confirmado, com o texto "Confirme o telefone para usar o WhatsApp."; salvar → `setNotificationChannelAction({ channel })`.
- `ChangePasswordForm` (`"use client"`): senha atual, nova, confirmação (`newPasswordSchema` + senha atual obrigatória, como `change-password/page.tsx`); `authClient.changePassword({ currentPassword, newPassword })` (o handler força `revokeOtherSessions` e recusa senha igual); mensagens: 429 → "Muitas tentativas. Aguarde alguns segundos."; `INVALID_PASSWORD` → "Senha atual incorreta."; `PASSWORD_UNCHANGED` → "A nova senha deve ser diferente da senha atual."; sucesso → "Senha alterada. Os outros dispositivos foram desconectados."
- `RevokeSessionsButton` (`"use client"`): "Sair dos outros dispositivos" → `authClient.revokeOtherSessions()`; sucesso → "Outros dispositivos desconectados."; erro → "Não foi possível desconectar os outros dispositivos."
- `portal/credits/page.tsx`: leia `getClientAccountStatus` na transação existente. Com `hasPermission(session, "credits:topup")` e `!status.emailVerified`, troque `<ClientTopupDialog />` por `<p className="text-sm text-muted-foreground">Confirme seu e-mail para comprar créditos.</p>`. `ClientTopupDialog` não muda.
- Textos em pt-BR. Estados de carregamento e erro visíveis; rótulos acessíveis.

**Testes:** UI de apresentação não leva teste; regras e mensagens estão nas Tasks 1–3. Verificação visual: `npm run dev` com `WHATSAPP_DRIVER=fake`; cliente novo vê o banner e o aviso em créditos; pede código e lê no console (`[whatsapp:fake]`) depois de rodar o worker (`docs/operations/notifications.md`); confirma; escolhe WhatsApp; troca a senha; desconecta outro navegador. Se não for possível abrir o navegador, diga isso no relatório. Leia o link ou o código em `notifications.params` (como dono) ANTES de rodar o worker: `complete_notification` apaga `params` depois do envio.

- [ ] Implemente, rode `npm run lint && npm run type-check`.
- [ ] Verifique as telas no navegador, ou declare que não verificou.
- [ ] Entregue: lista de `Files changed`.

---

### Task 6: Documentação

**Agent:** `documentation-writer` · `model: "haiku"`
**Files:**
- Modify: `docs/architecture.md`
- Modify: `PRODUCT.md`
- Modify: `docs/operations/notifications.md`

**Depends-on:** 1

**Contrato:**
- `docs/architecture.md`: a faixa de migrations passa de `001` a `020` para `001` a `021`; acrescente uma linha sobre a 021 (contas de cliente: `legal_documents`, `legal_acceptances`, `verification_challenges`, `client_register_attempts`, funções `register_client` e de verificação).
- `PRODUCT.md`: linha do M5 na tabela de milestones passa a "em execução" com link para a spec `docs/superpowers/specs/2026-10-15-m5-contas-de-cliente-design.md`; remova a pendência "as specs do M5..." e ajuste o próximo passo.
- `docs/operations/notifications.md` §4: acrescente o template de autenticação `verification_code` (`pt_BR`, botão "copiar código"), registrado pela migration 021, ao lado dos templates Utility. Marque a aprovação na Meta como post-deploy.
- Sem outra mudança. Textos em pt-BR, ASD-STE100.

**Testes:** nenhum (documentação). Gate: `npm run lint` passa.

- [ ] Edite os três arquivos.
- [ ] Entregue: lista de `Files changed`.

---

## Critérios de pronto

Cada critério aponta para o teste que o prova (lista da spec).

- Cadastro atômico: usuário, conta, perfil, Titular, carteira, aceites, auditoria, desafio e notificação; falha não deixa linha (Task 1: `register_client creates every row in one transaction`, `email challenge failure rolls back the whole registration`; Task 3: cadastro ponta a ponta).
- Dígito de CPF/CNPJ (Task 2: `registerFormSchema`).
- Mesmo documento em outro Bureau com outro e-mail; recusado no mesmo Bureau (Task 1).
- 11ª tentativa por IP na hora recusada (Task 1).
- Link de e-mail: 24 h, uso único, pedido novo invalida o anterior (Task 1).
- Reenvio: 60 s e 5 por hora (Task 1).
- Código de telefone: 10 min, 5 tentativas (Task 1).
- Só hash no desafio; colunas novas de `profiles` fechadas para `app_runtime` (Task 1, RLS).
- Nada sensível em auditoria, log ou erro (Task 1, 3).
- Aceite com versão, data, IP e user-agent; versão nova pede aceite (Task 1, 3).
- Compra recusada sem e-mail confirmado; telefone não bloqueia (Task 3).
- WhatsApp como canal exige telefone confirmado (Task 1, 3).
- Rotas públicas novas sem sessão (Task 2).
- Telas (Task 4, 5; verificação visual; `npm run build`).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da onda 3.
- (post-deploy) A Meta aprova `verification_code` (autenticação, `pt_BR`, botão copiar código) e um código real chega.
- (post-deploy) O texto jurídico real entra como versão 2 (migration nova) antes da abertura do cadastro ao público.
- (post-deploy) Um e-mail real de confirmação chega e o link confirma a conta.

Cada item `(post-deploy)` vira um item "Post-deploy follow-up" no PR. Nenhum bloqueia o merge.

## Cobertura da spec

| Spec / issue | Task |
|---|---|
| #37 Validação de dígito de CPF/CNPJ | 2 (zod), 1 (tamanho no SQL) |
| #37 Mesmo documento em Bureaus diferentes | 1 |
| #38 Link de verificação com expiração | 1, 3, 4 |
| #38 Reenvio com rate limit | 1, 3, 5 |
| #39 Código de uso único com expiração e tentativas limitadas | 1, 2 (template), 3, 5 |
| #40 Registro de versão, data e IP do aceite | 1, 3, 4 |
| #40 Novo aceite quando a versão muda | 1, 3, 5 (TermsGate) |
| #41 Carteira e extrato | já existe (`/portal/credits`); 5 (aviso de compra) |
| #41 Perfil e segurança | 3, 5 |
| #41 Pesquisas e entregas liberadas | fora (M6, D1) |
| Decisões 1–3 (cadastro, uma conta por e-mail) | 1, 2, 3, 4 |
| Decisão 4 (tabelas) | 1 |
| Decisão 5 (segredos) | 1, 2 |
| Decisões 6–7 (confirmações) | 1, 3, 4, 5 |
| Decisão 8 (limite por IP) | 1, 2 |
| Decisão 9 (notificação sem staff, templates) | 1, 2 |
| Decisão 10 (termos) | 1, 3, 4, 5 |
| Decisão 11 (bloqueio de compra, D2) | 3, 5 |
| Decisões 12–13 (perfil, canal) | 1, 3, 5 |
| Decisão 14 (rotas públicas, slugs) | 1, 2 |
| Decisão 15 (driver fake) | 2 |

## Ajustes nas issues (fora das tasks)

- #37, #38, #39, #40: fechar com o PR. `Closes #37` e `Closes #40` no commit da Task 4; `Closes #38` e `Closes #39` no commit da Task 5 (a task que entrega a última tela de cada uma).
- #41: fechar com o PR (`Closes #41` no commit da Task 5), depois de mover "Pesquisas e entregas liberadas" para o M6.
- Comentário no #41:

  > O critério "Pesquisas e entregas liberadas" saiu do M5 (decisão D1 da spec `docs/superpowers/specs/2026-10-15-m5-contas-de-cliente-design.md`) e foi para a issue nova do M6 "Portal: pesquisas e entregas liberadas ao cliente". O M5 entrega carteira e extrato, perfil e segurança.

- Issue nova no milestone "M6 — Pesquisa e entrega", labels `enhancement`, `front`:

  ```
  gh issue create --milestone "M6 — Pesquisa e entrega" --label enhancement --label front \
    --title "Portal: pesquisas e entregas liberadas ao cliente" \
    --body-file - <<'EOF'
  Movido do #41 (M5, decisão D1). O cliente vê no portal as pesquisas que comprou e as entregas que o operador liberou.

  **Critérios de aceite**
  - [ ] Lista das pesquisas do cliente, com estado
  - [ ] Entrega liberada: relatório na tela e PDF
  - [ ] RLS: o cliente lê só as próprias pesquisas e só entregas liberadas

  **Depende de:** M5, #45, #46

  Referência: [spec](https://github.com/felip2ee/credit-system/blob/feature/m0-fundacao/docs/superpowers/specs/2026-10-13-plataforma-bureau-produto-design.md)
  EOF
  ```

- #34: o critério "Preferência de canal por destinatário" fica guardado e visível no M5 (`profiles.notification_channel`); o uso no envio fica no M6. Comente isso na #34.
