# M1 — Multi-tenant e domínio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute com `superpowers:subagent-driven-development` em **ondas paralelas** (`Files:` / `Depends-on:`, regra `.claude/rules/08-parallel-subagent-driven-development.md`). Os implementadores **não fazem commit**: deixam as mudanças na árvore e reportam `Files changed`. O controlador faz um commit por task, na ordem do plano. Sem reviewer por task. Steps usam checkbox (`- [ ]`).

**Goal:** Isolar cada Bureau no banco (RLS por `bureau_id`), trocar o domínio para Titular/Sociedade/Dossiê/Consulta, entregar o painel do superadmin, o modo suporte auditado, a equipe do Bureau e a página `/b/<slug>`.

**Architecture:** As migrations 003/004/005/008/009 são editadas no lugar (base editável). Um terceiro GUC `app.bureau_id` e um quarto `app.support_session_id` entram em `withUserTransaction`. Toda política de tenant exige `bureau_id = app_bureau_id()`. FKs compostas `(bureau_id, id)` impedem referência cruzada. O superadmin só lê dados de tenant com sessão de suporte ativa, verificada em SQL. As camadas seguem o padrão atual: Server Action → `lib/<domínio>/queries.ts` → SQL parametrizado.

**Tech Stack:** Next.js 14.2 (App Router), Better Auth 1.7.2, PostgreSQL 18.6 (RLS), node-postgres 8.21, zod, Vitest 4, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-14-m1-multitenant-design.md` (produto: `docs/superpowers/specs/2026-10-13-plataforma-bureau-produto-design.md`). Issues: #13–#21.

## Global Constraints

- **Base editável:** edite `db/migrations/003, 004, 005, 008, 009` no lugar. Não crie migration de correção. Esta regra vence a linha "Never edit an applied migration" de `db/migrations/CLAUDE.md` até o primeiro deploy.
- Recrie o banco de dev antes dos testes de integração: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Testes de integração (`*.integration.test.ts`) rodam contra `127.0.0.1:54329`. Todos usam `src/test/seed.ts`.
- Passe `session` (ou `DbIdentity`) inteiro como identidade. Nunca remonte `{ userId, role }` à mão: perde `bureauId`.
- Chame `hasPermission(subject, permission)` com o objeto (`session`/identidade), não com `role`.
- `bureau_id` de escrita vem sempre da identidade. Nunca de formulário, query string ou parâmetro.
- Auditoria no mesmo cliente da transação (`writeAuditEvent(client, …)`). Nunca CPF/CNPJ completo em `metadata`.
- Server Actions: zod `safeParse` → `getRequiredSession` → `hasPermission` → query → `revalidatePath`; retorno `{ error: string | null, id? }`. Queries retornam `{ ok: false, reason }` para conflito de negócio.
- Identificadores em inglês. Textos de UI, erros e comentários em pt-BR. Rotas em inglês (`/holders`, `/dossiers`), exceto as públicas (`/b/`, `/autorizacao-scr/`).
- Nenhum literal `"Smart PF"`/`"Smart PJ"` fora de `src/lib/deps/products.ts`.
- **Gate da task:** os testes do escopo da task passam. `npm run lint && npm run type-check && npm run test` só fica verde depois da onda 4 (a troca de `DbIdentity` quebra os chamadores até lá).
- Implementadores: agente especialista com `model: "sonnet"`. Nunca `opus`.
- Commits: um por task, mensagem Conventional Commits, `Closes #n` no corpo, linha final `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Rode `git rev-parse --short HEAD` logo antes e registre o hash. `git add` só dos `Files:` da task.

## Review Focus

1. Vazamento entre tenants pela política do portal do cliente ou por FK cruzada — Task 1: `client sees only own holder`, `composite FK rejects cross-bureau reference`.
2. Superadmin lê dados pessoais sem sessão de suporte ativa, ou com sessão expirada/encerrada — Task 1: `superadmin without support sees zero rows`, `expired/ended support denied`; Task 2: `expired support is not loaded`.
3. Mesmo CPF em dois Bureaus deve passar; duplicado (com ou sem máscara) no mesmo Bureau deve falhar — Task 1: `holder uniqueness`.
4. Confirmação pública do SCR grava `bureau_id` errado ou nulo na timeline — Task 1: `gateway writes the authorization bureau_id`.
5. Slug reservado aceito, ou resposta diferente entre slug inexistente e inativo — Task 1: `slug checks`; Task 3: `getPublicBureau returns null for unknown and inactive`.

---

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `db/migrations/003_business.sql` | enums, `bureaus`, tabelas de tenant, `support_sessions`, triggers | 1 |
| `db/migrations/004_rls.sql` | helpers de contexto, `auth_profile_for_session`, políticas, grants | 1 |
| `db/migrations/005_indexes.sql` | índices com `bureau_id` na frente | 1 |
| `db/migrations/008_*.sql`, `009_*.sql` | gateway SCR, `public_bureau_by_slug`, `platform_bureau_metrics`, grants de `auth_profile_lookup` | 1 |
| `src/test/seed.ts` | seed compartilhado via DSN do superusuário | 1 |
| `src/lib/db/{transaction,permissions}.ts` | GUCs do tenant e matriz de permissões | 2 |
| `src/lib/auth/{authorization,session,bootstrap,invite}.ts` | perfil com Bureau, sessão com suporte, superadmin, convite | 2 |
| `src/lib/audit/write.ts` | grava `bureau_id` e `support_session_id` do contexto | 2 |
| `src/app/b/[slug]/page.tsx`, `src/lib/bureaus/public.ts`, `src/middleware.ts` | página pública | 3 |
| `src/lib/holders/`, `src/lib/dossiers/`, `src/actions/{holders,dossiers}.ts` | domínio novo | 4 |
| `src/lib/bureaus/queries.ts`, `src/actions/bureaus.ts`, `src/app/(superadmin)/` | painel do superadmin | 5 |
| `src/actions/users.ts`, `src/app/(dashboard)/settings/{page,users/page}.tsx` | equipe do Bureau | 6 |
| `src/app/(dashboard)/{holders,dossiers}/`, `src/components/{holders,dossiers}/` | telas Pesquisas e Titular | 7 |
| `src/lib/support/queries.ts`, `src/actions/support.ts`, `src/components/layout/support-banner.tsx` | modo suporte | 8 |

**Arquivos compartilhados e dono único por onda:** `src/app/(dashboard)/layout.tsx` → Task 5 (onda 3), depois Task 8 (onda 4). `src/components/layout/sidebar.tsx` → Task 7. `src/lib/dashboard/queries.ts` → Task 4; `src/app/(dashboard)/page.tsx` → Task 7. `src/app/(dashboard)/settings/page.tsx` → Task 6. Telas de settings prompts/SCR → Task 5. `src/middleware.ts` → Task 3. `src/types/app.ts` → Task 2 (papéis), depois Task 4 (domínio).

## Ondas

| Onda | Tasks | Por quê |
|---|---|---|
| 1 | 1 | schema e RLS são a base de tudo |
| 2 | 2, 3 | 3 só usa `public_bureau_by_slug`; arquivos disjuntos |
| 3 | 4, 5, 6 | dependem só da Task 2; arquivos disjuntos |
| 4 | 7, 8 | 7 depende da 4; 8 depende da 5; arquivos disjuntos |

Depois de cada onda, o controlador faz os commits em ordem de número de task.

---

### Task 1: Schema de tenant, RLS e testes de isolamento (refs #13, #14, #15, #16)

**Agent:** `database-architect` (`model: "sonnet"`). Invoque `/postgresql-database-engineering`.
**Depends-on:** none
**Files:**
- Modify: `db/migrations/003_business.sql`, `004_rls.sql`, `005_indexes.sql`, `008_public_scr_authorization.sql`, `009_public_scr_gateway_privileges.sql`
- Create: `src/test/seed.ts`
- Rewrite: `src/lib/db/rls.integration.test.ts`

**Regras:** `06-security` (menor privilégio, isolamento por tenant), `db/migrations/CLAUDE.md` (padrão SECURITY DEFINER, nomes de política e índice), base editável.

**003 — DDL obrigatório (forma exata):**

```sql
create type user_role as enum ('superadmin', 'bureau_admin', 'operator', 'client');
create type dossier_kind as enum ('PF', 'PJ', 'PJ_FULL');
create type dossier_status as enum ('pending', 'processing', 'completed', 'completed_with_errors', 'cancelled');
create type timeline_entity_type as enum ('holder', 'query');
-- remove batch_status; query_type, consultation_status e scr_status ficam.

create table bureaus (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '' and length(name) <= 120),
  slug text not null unique,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bureaus_slug_format check (slug ~ '^[a-z0-9-]{3,40}$'),
  constraint bureaus_slug_not_reserved check (slug not in (
    'admin', 'api', 'app', 'auth', 'b', 'dashboard', 'login', 'logout', 'mfa',
    'portal', 'autorizacao-scr', 'superadmin', 'settings', 'reset-password',
    'update-password', 'static', 'www'))
);

-- profiles: role sem default; ganha bureau_id.
--   bureau_id uuid references bureaus(id),
--   constraint profiles_bureau_matches_role check ((role = 'superadmin') = (bureau_id is null)),
--   unique (bureau_id, id)

create table holders (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  type query_type not null,
  name text not null,
  document text not null,
  document_digits text generated always as (regexp_replace(document, '\D', '', 'g')) stored,
  email text, phone text, address text, address_number text, address_complement text,
  neighborhood text, city text, state char(2), zip_code text, notes text,
  client_profile_id uuid,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bureau_id, id),
  constraint holders_document_unique unique (bureau_id, document_digits),
  constraint holders_document_length check (
    (type = 'PF' and length(document_digits) = 11) or (type = 'PJ' and length(document_digits) = 14)),
  foreign key (bureau_id, client_profile_id) references profiles (bureau_id, id)
);

create table holder_partnerships (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null,
  company_id uuid not null,
  partner_id uuid not null,
  percentage numeric(5,2) check (percentage between 0 and 100),
  role text,
  source text not null check (source in ('deps', 'operator')),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, partner_id),
  check (company_id <> partner_id),
  foreign key (bureau_id, company_id) references holders (bureau_id, id),
  foreign key (bureau_id, partner_id) references holders (bureau_id, id)
);

create table dossiers (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null references bureaus(id),
  kind dossier_kind not null,
  holder_id uuid not null,
  product text not null,
  status dossier_status not null default 'pending',
  created_by uuid not null references profiles(id),
  started_at timestamptz,
  completed_at timestamptz,
  -- parecer consolidado (antigo company_reports)
  report_status text not null default 'none'
    check (report_status in ('none', 'generating', 'completed', 'error')),
  aptitude_status text not null default 'pending',
  executive_summary text, positive_points jsonb, risk_points jsonb, action_plan jsonb,
  suggested_products jsonb, suggested_limit numeric(15,2), suggested_limit_notes text,
  report_markdown text, full_report jsonb, model_used text, prompt_version text,
  generated_at timestamptz, generation_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bureau_id, id),
  foreign key (bureau_id, holder_id) references holders (bureau_id, id)
);

create table support_sessions (
  id uuid primary key default gen_random_uuid(),
  superadmin_id uuid not null references profiles(id),
  bureau_id uuid not null references bureaus(id),
  reason text not null check (btrim(reason) <> '' and length(reason) <= 500),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour',
  ended_at timestamptz,
  check (expires_at > started_at and expires_at <= started_at + interval '1 hour'),
  check (ended_at is null or ended_at >= started_at)
);
```

Mudanças nas tabelas existentes (siga o padrão das FKs compostas acima):
- `consultations`: `bureau_id not null`, `holder_id not null`, `dossier_id not null`; sai `crm_client_id` e `batch_id`; `unique (bureau_id, id)`; FKs `(bureau_id, holder_id) → holders`, `(bureau_id, dossier_id) → dossiers`.
- `scr_authorizations`: `bureau_id not null`, `holder_id not null` (FK composta), `consultation_id` com FK composta; sai `crm_client_id`.
- `bureau_payloads`: `bureau_id not null`, FK composta para `consultations`, `unique (bureau_id, id)`. `bureau_results`: `bureau_id not null`, FKs compostas para `consultations` e `bureau_payloads`.
- `ai_reports`: `bureau_id not null`, FK composta para `consultations`; `crm_client_id` vira `holder_id` (FK composta, nulo permitido).
- `timeline_events`, `crm_notes`: `bureau_id uuid not null references bureaus(id)`.
- `audit_logs`: `bureau_id uuid references bureaus(id)` (nulo = plataforma), `support_session_id uuid references support_sessions(id)`.
- Remova `crm_clients`, `crm_client_documents`, `crm_client_relations`, `batches`, `company_reports`.
- Triggers `set_updated_at` para `bureaus`, `holders`, `holder_partnerships`, `dossiers`. `owner to schema_owner` para todo objeto novo.

**004 — contexto e políticas (forma exata dos helpers):**

```sql
create or replace function app_bureau_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.bureau_id', true), '')::uuid
$$;
create or replace function app_support_session_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.support_session_id', true), '')::uuid
$$;
create or replace function app_context_present() returns boolean language sql stable as $$
  select app_user_id() is not null
    and app_user_role() in ('superadmin', 'bureau_admin', 'operator', 'client')
$$;

-- Owner auth_profile_lookup. Lê support_sessions sem expor a tabela ao app.
create function app_support_active() returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.support_sessions s
     where s.id = public.app_support_session_id()
       and s.superadmin_id = public.app_user_id()
       and s.bureau_id = public.app_bureau_id()
       and s.ended_at is null
       and s.expires_at > now())
$$;

create function app_is_staff() returns boolean language sql stable as $$
  select app_context_present() and (
    app_user_role() in ('bureau_admin', 'operator')
    or (app_user_role() = 'superadmin' and app_support_active()))
$$;

create function auth_profile_for_session(auth_id text)
returns table (
  user_id uuid, role text, bureau_id uuid, bureau_active boolean,
  is_active boolean, mfa_enabled boolean,
  support_session_id uuid, support_bureau_id uuid, support_expires_at timestamptz
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select p.id, p.role::text, p.bureau_id, coalesce(b.status = 'active', false),
         p.is_active, p.mfa_enabled, s.id, s.bureau_id, s.expires_at
    from public.profiles p
    left join public.bureaus b on b.id = p.bureau_id
    left join lateral (
      select ss.id, ss.bureau_id, ss.expires_at
        from public.support_sessions ss
       where p.role = 'superadmin' and ss.superadmin_id = p.id
         and ss.ended_at is null and ss.expires_at > now()
       order by ss.started_at desc
       limit 1) s on true
   where p.auth_user_id = auth_id
$$;
```

Políticas (forma exata do molde de tenant; aplique a `holders`, `holder_partnerships`, `dossiers`, `consultations`, `scr_authorizations`, `bureau_payloads`, `bureau_results`, `ai_reports`, `crm_notes`; em `timeline_events` só select e insert):

```sql
create policy holders_staff on holders for all
  using (bureau_id = app_bureau_id() and (select app_is_staff()))
  with check (bureau_id = app_bureau_id() and (select app_is_staff()));
create policy holders_client_select on holders for select
  using (app_context_present() and app_user_role() = 'client'
         and bureau_id = app_bureau_id() and client_profile_id = app_user_id());
```

Regras de política para as demais tabelas:
- `bureaus`: select para superadmin (todas) e para quem tem `id = app_bureau_id()`; insert/update só superadmin. Grant de update só em `(name, status)`.
- `profiles`: select do próprio perfil; staff vê perfis do próprio Bureau; superadmin vê perfis `superadmin` e `bureau_admin`. Insert: `bureau_admin` no próprio Bureau com papel `bureau_admin | operator | client`; superadmin cria `bureau_admin` com `bureau_id` não nulo, ou o próprio perfil `superadmin` (`id = app_user_id()`, bootstrap). Update: o próprio perfil ou `bureau_admin` no próprio Bureau.
- `protect_profile_identity`: `id`, `auth_user_id`, `created_at`, `bureau_id` imutáveis. `role`, `is_active`, `mfa_enabled` mudam só com `app_user_role() = 'bureau_admin'`. Papel muda só entre `bureau_admin` e `operator`.
- `support_sessions`: superadmin lê, cria e encerra só as próprias (`superadmin_id = app_user_id()`). Grants: `select, insert`, `update (ended_at)`.
- `audit_logs` select: `bureau_admin` com `bureau_id = app_bureau_id()`; superadmin com `bureau_id is null or support_session_id is not null`.
- `audit_logs` insert (forma exata):

```sql
create policy audit_logs_insert on audit_logs for insert with check (
  app_context_present()
  and user_id = app_user_id()
  and bureau_id is not distinct from app_bureau_id()
  and support_session_id is not distinct from app_support_session_id()
  and (bureau_id is null) = (app_user_role() = 'superadmin' and app_support_session_id() is null));
```

- `settings`: select com `app_context_present()`; escrita só `app_user_role() = 'superadmin'`.
- Grants do `app_runtime`: mantenha o padrão atual. Novas: `bureaus (select, insert, update(name, status))`, `holders`, `holder_partnerships`, `dossiers` (`select, insert, update`), `support_sessions` (acima). Execute em `app_bureau_id`, `app_support_session_id`, `app_is_staff`, `app_support_active`, `auth_profile_for_session`.

**008/009 — gateway e funções públicas:**
- 008 fica só com `public_scr_authorization`. Apague o primeiro corpo de `confirm_public_scr_authorization`. 009 tem a única definição.
- `confirm_public_scr_authorization`: assinatura igual (`text, text, text, text, text) returns text`). Lê `s.holder_id` e `s.bureau_id`. Sempre insere a timeline com `(bureau_id, entity_type, entity_id, event_type, title) = (v_bureau_id, 'holder', v_holder_id, …)`.
- 009 é a lista completa de grants do `auth_profile_lookup`: colunas de `profiles` + `bureau_id`; `bureaus (id, name, slug, status)`; `support_sessions (id, superadmin_id, bureau_id, started_at, expires_at, ended_at)`; `scr_authorizations` com `bureau_id, holder_id` no lugar de `crm_client_id`; insert em `timeline_events (bureau_id, entity_type, entity_id, event_type, title)`; `holders (id, bureau_id)`, `dossiers (id, bureau_id)`, `consultations (id, bureau_id, created_at)` para métricas. Cada tabela recebe uma política `<tabela>_gateway_select … to auth_profile_lookup using (true)`.
- Política `timeline_events_gateway_insert`: `entity_type = 'holder'`, pares `event_type/title` atuais e:

```sql
exists (select 1 from public.scr_authorizations s
         where s.holder_id = timeline_events.entity_id
           and s.bureau_id = timeline_events.bureau_id
           and s.channel = 'internal')
```

- Funções novas (owner `auth_profile_lookup`, `revoke all … from public`, `grant execute … to app_runtime`):

```sql
create function public_bureau_by_slug(p_slug text)
returns table (name text, slug text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select b.name, b.slug from public.bureaus b
   where b.slug = p_slug and b.status = 'active'
$$;

create function platform_bureau_metrics()
returns table (bureau_id uuid, name text, slug text, status text,
               staff_count bigint, holder_count bigint, dossier_count bigint,
               consultation_count bigint, consultations_30d bigint)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if public.app_user_id() is null or public.app_user_role() is distinct from 'superadmin' then
    raise exception 'superadmin context required' using errcode = '42501';
  end if;
  return query <select das contagens>;
end
$$;
```

`<select das contagens>`: uma linha por Bureau, com `count` de `profiles` (`bureau_admin`, `operator`), `holders`, `dossiers`, `consultations` e `consultations` com `created_at > now() - interval '30 days'`. Use só as colunas `id`, `bureau_id`, `role` e `created_at`.

**005 — índices:** `holders (bureau_id, type, name)`; `dossiers (bureau_id, kind, created_at desc)`; `consultations (bureau_id, dossier_id)`, `(bureau_id, holder_id, created_at desc)`, `(bureau_id, created_by, status, created_at desc)`, `(bureau_id, (regexp_replace(document, '\D', '', 'g')))`; `holder_partnerships (bureau_id, partner_id)`; `scr_authorizations (bureau_id, holder_id)`; `timeline_events (bureau_id, entity_type, entity_id, created_at desc)`; `audit_logs (bureau_id, created_at desc)`; `support_sessions (superadmin_id) where ended_at is null`; mantenha `bureau_payloads_consultation_idx` e `bureau_results (bureau_id, document)`.

**`src/test/seed.ts` — contrato:**

```ts
// Só para testes de integração. Grava via TEST_DATABASE_OWNER_URL (superusuário, ignora RLS).
export type SeedIdentity = { userId: string; role: "bureau_admin" | "operator" | "client"; bureauId: string };
export type SeedSuperadmin = { userId: string; role: "superadmin"; bureauId: null };
export type SeededTenant = {
  bureau: { id: string; name: string; slug: string };
  bureauAdmin: SeedIdentity; operator: SeedIdentity; client: SeedIdentity;
  holder: { id: string; document: string }; // Titular PF ligado ao client
};
export async function seedTenant(owner: Pool, label: string): Promise<SeededTenant>;
export async function seedSuperadmin(owner: Pool): Promise<SeedSuperadmin>;
export async function seedSupportSession(owner: Pool, input: {
  superadminId: string; bureauId: string; reason?: string; startedAt?: Date; expiresAt?: Date; endedAt?: Date | null;
}): Promise<string>;
// begin → set_config dos 4 GUCs (local) → work → rollback. Não depende de src/lib.
export async function withDbContext<T>(pool: Pool, ctx: {
  userId: string; role: string; bureauId: string | null; supportSessionId?: string | null;
}, work: (client: PoolClient) => Promise<T>): Promise<T>;
```

Rótulos e documentos aleatórios por chamada. Os testes rodam em paralelo sem colisão.

**Casos de teste (`rls.integration.test.ts`, 2 tenants A e B via `seedTenant`):**
- Tabela por tabela (todas as de tenant): operador de A não lê linhas de B; insert com `bureau_id` de B falha; update e delete em linhas de B afetam 0 linhas ou falham por privilégio.
- `composite FK rejects cross-bureau reference`: consulta de A com `holder_id` de B falha (FK).
- `client sees only own holder`: cliente de A vê só o Titular ligado a ele; não vê outro Titular de A nem os de B.
- `superadmin without support sees zero rows` em toda tabela de tenant.
- Superadmin com sessão ativa em A vê linhas de A e zero de B.
- `expired/ended support denied`: sessão expirada, encerrada, de outro superadmin ou com GUC de Bureau diferente → zero linhas.
- Sessão de suporte com `reason` vazio ou só espaços falha (CHECK). `expires_at` acima de 1 hora falha.
- `holder uniqueness`: mesmo CPF em A e B passa; `123.456.789-01` e `12345678901` no mesmo Bureau falham (`holders_document_unique`).
- `gateway writes the authorization bureau_id`: `confirm_public_scr_authorization` grava a timeline com o `bureau_id` da autorização e `entity_type = 'holder'`.
- `slug checks`: `public_bureau_by_slug` devolve só `name, slug` do ativo; zero linhas para inativo e inexistente; insert com slug `admin` ou `AB` falha.
- `platform_bureau_metrics`: superadmin recebe contagens; operador recebe erro `42501`.
- Perfil: `superadmin` com `bureau_id` falha; `operator` sem `bureau_id` falha; operador não muda o próprio papel.
- `settings`: operador e `bureau_admin` não gravam; superadmin grava; todos leem.
- `audit_logs`: insert com `bureau_id` diferente do GUC falha; insert em suporte exige `support_session_id` igual ao GUC.

- [ ] **Step 1:** Escreva `src/test/seed.ts` e os casos acima em `rls.integration.test.ts`.
- [ ] **Step 2:** Rode `npm run db:reset` (DSN acima) e `npx vitest run src/lib/db/rls.integration.test.ts`. Esperado: FAIL (schema antigo).
- [ ] **Step 3:** Edite 003, 004, 005, 008, 009 conforme a especificação.
- [ ] **Step 4:** Rode `npm run db:reset`, `npm run db:migrate:test` e o teste do Step 2. Esperado: PASS.
- [ ] **Step 5: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add db/migrations/003_business.sql db/migrations/004_rls.sql db/migrations/005_indexes.sql \
  db/migrations/008_public_scr_authorization.sql db/migrations/009_public_scr_gateway_privileges.sql \
  src/test/seed.ts src/lib/db/rls.integration.test.ts
git commit -m "feat(db): add bureaus, tenant columns and tenant RLS

Refs #13 #14 #15 #16

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Identidade com Bureau, permissões, sessão, bootstrap e convite (closes #13, #14)

**Agent:** `backend-specialist` (`model: "sonnet"`)
**Depends-on:** 1
**Files:**
- Modify: `src/lib/db/transaction.ts`, `src/lib/db/transaction.test.ts`, `src/lib/db/permissions.ts`, `src/lib/db/permissions.test.ts`
- Modify: `src/lib/auth/authorization.ts`, `src/lib/auth/session.ts`, `src/lib/auth/bootstrap.ts`, `src/lib/auth/bootstrap.integration.test.ts`, `src/lib/auth/auth.integration.test.ts`
- Modify: `src/lib/auth.ts`, `src/lib/auth.test.ts`, `src/lib/audit/write.ts`, `src/types/app.ts` (só `UserRole`)
- Create: `src/lib/auth/invite.ts`, `src/lib/auth/invite.integration.test.ts`

**Regras:** `06-security`, decisões 2, 3, 5, 7 e 9 da spec. `invite.idempotent-resend` (abaixo).

**Interfaces:**

```ts
// transaction.ts
export type AppRole = "superadmin" | "bureau_admin" | "operator" | "client";
export type DbIdentity = { userId: string; role: AppRole; bureauId: string | null; supportSessionId?: string | null };
// withUserTransaction: mesma assinatura; define app.user_id, app.user_role, app.bureau_id, app.support_session_id
// (string vazia quando nulo), nessa ordem, com set_config(..., true).

// permissions.ts
export type PermissionSubject = Pick<DbIdentity, "role" | "supportSessionId">;
export function hasPermission(subject: PermissionSubject, permission: Permission): boolean;
export function permissionsFor(subject: PermissionSubject): readonly Permission[];
// superadmin + supportSessionId → permissões da plataforma ∪ permissões do operator.

// authorization.ts
export type AuthProfile = {
  userId: string; role: AppRole; bureauId: string | null; bureauActive: boolean;
  isActive: boolean; mfaEnabled: boolean;
  support: { sessionId: string; bureauId: string; expiresAt: Date } | null;
};
export async function findAuthProfile(authUserId: string): Promise<AuthProfile | null>;
export async function changeRoleAndRevokeSessions(actorUserId: string, userId: string, role: "bureau_admin" | "operator"): Promise<void>;
export async function deactivateUserAndRevokeSessions(actorUserId: string, userId: string): Promise<void>;
// a transação de administração exige bureau_admin ativo e usa a identidade completa.

// session.ts
export type RequiredSession = DbIdentity & {
  permissions: readonly Permission[]; mfaComplete: boolean; name: string; email: string;
  support: { bureauId: string; expiresAt: Date } | null;
};
// SessionAccessError ganha o código "bureau_inactive".

// invite.ts — roda no cliente da transação do chamador.
export type InviteInput = { email: string; fullName: string; role: "bureau_admin" | "operator" | "client"; bureauId: string };
export type InviteOutcome =
  | { ok: true; userId: string; resent: boolean }
  | { ok: false; reason: "email_in_use" | "already_member" };
export const inviteInputSchema: z.ZodType<InviteInput>; // email normalizado, nome ≥ 3, bureauId uuid
export async function createInvite(client: PoolClient, actorId: string, input: InviteInput): Promise<InviteOutcome>;
export async function sendInviteEmail(email: string): Promise<boolean>; // requestPasswordReset; false em falha
```

**Regras de negócio:**
- `session.mfa-staff`: `superadmin`, `bureau_admin` e `operator` sem TOTP → `mfa_setup_required` (sem revogar).
- `session.bureau-inactive`: papel diferente de superadmin com `bureauActive = false` → revoga sessões e lança `bureau_inactive`.
- `session.support`: superadmin com `support` → `bureauId = support.bureauId`, `supportSessionId = support.sessionId`. Sem suporte → `bureauId = null`.
- `bootstrap.superadmin`: cria perfil `superadmin` com `bureau_id` nulo, identidade `{ role: "superadmin", bureauId: null }`. Usuário existente: não muda nada.
- `invite.idempotent-resend`: e-mail novo → cria `user` + `profile` + auditoria `user.invite` no mesmo cliente. Mesmo e-mail, mesmo Bureau, mesmo papel, sem linha em `account` → `resent: true`, sem insert. Mesmo e-mail com conta já ativada → `already_member`. Perfil com outro papel ou Bureau, ou `user` sem perfil → `email_in_use`.
- `writeAuditEvent`: grava `bureau_id = app_bureau_id()` e `support_session_id = app_support_session_id()` no próprio SQL. A assinatura não muda.

**Casos de teste:**
- `permissions.test.ts`: matriz completa por papel (tabela da spec). `bureau_admin` sem `settings:write`, `bureaus:manage`, `support:enter`. `operator` sem `users:manage` e `audit:read`. Superadmin sem suporte sem `holders:read`; com suporte, com `holders:read` e sem `users:manage`. `client` só `portal:*`.
- `transaction.test.ts`: os 4 `set_config` na ordem; `''` para `bureauId` nulo e `supportSessionId` ausente; rollback em erro.
- `auth.integration.test.ts`: operador de Bureau ativo recebe `bureauId`; Bureau inativo → `bureau_inactive` e sessões revogadas; superadmin, `bureau_admin` e `operator` sem MFA → `mfa_setup_required`; `client` sem MFA passa; superadmin com sessão de suporte ativa recebe `bureauId` e `supportSessionId`; `expired support is not loaded` (sessão expirada → `bureauId` nulo).
- `bootstrap.integration.test.ts`: perfil `superadmin`, `bureau_id` nulo; segunda chamada → `"exists"` sem alteração.
- `invite.integration.test.ts`: os 4 ramos de `invite.idempotent-resend`; `bureauId` não uuid → falha no schema; erro depois do insert desfaz `user`, `profile` e auditoria juntos.

- [ ] **Step 1:** Escreva os testes acima. Rode `npx vitest run src/lib/db/permissions.test.ts src/lib/db/transaction.test.ts src/lib/auth/`. Esperado: FAIL.
- [ ] **Step 2:** Implemente os contratos. Atualize `src/lib/auth.ts` e `UserRole` em `src/types/app.ts`.
- [ ] **Step 3:** Rode `npm run db:reset` e o comando do Step 1. Esperado: PASS.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add src/lib/db/transaction.ts src/lib/db/transaction.test.ts src/lib/db/permissions.ts \
  src/lib/db/permissions.test.ts src/lib/auth/authorization.ts src/lib/auth/session.ts \
  src/lib/auth/bootstrap.ts src/lib/auth/bootstrap.integration.test.ts src/lib/auth/auth.integration.test.ts \
  src/lib/auth/invite.ts src/lib/auth/invite.integration.test.ts src/lib/auth.ts src/lib/auth.test.ts \
  src/lib/audit/write.ts src/types/app.ts
git commit -m "feat(auth): carry bureau and support context in the identity

Closes #13
Closes #14

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Página pública `/b/<slug>` (closes #21)

**Agent:** `frontend-specialist` (`model: "sonnet"`). Invoque `/vercel:nextjs`.
**Depends-on:** 1
**Files:**
- Create: `src/app/b/[slug]/page.tsx`, `src/lib/bureaus/public.ts`, `src/lib/bureaus/public.integration.test.ts`, `src/middleware.test.ts`
- Modify: `src/middleware.ts`

**Interfaces:**

```ts
// public.ts — sem identidade; usa pool.query na função SECURITY DEFINER.
export async function getPublicBureau(slug: string): Promise<{ name: string; slug: string } | null>;
// slug fora de /^[a-z0-9-]{3,40}$/ → null sem consultar o banco.
```

**Regras:**
- `public.no-enumeration`: inexistente, inativo ou inválido → `notFound()`. Mesma resposta, mesmo `metadata` genérico.
- A página mostra o nome do Bureau, um link "Entrar" para `/login` e o texto "Cadastro em breve". Sem marca do Bureau (sem white-label).
- O middleware libera os prefixos `/b/` e `/autorizacao-scr/`. Hoje a página pública do SCR redireciona para `/login` sem cookie; o prefixo corrige isso.

**Casos de teste:**
- `public.integration.test.ts`: ativo → `{ name, slug }`; `getPublicBureau returns null for unknown and inactive`; `"AB"` e `"a_b"` → `null`.
- `middleware.test.ts`: `/b/reino` sem cookie passa; `/autorizacao-scr/<token>` sem cookie passa; `/holders` sem cookie redireciona para `/login`; `/bx` sem cookie redireciona.

- [ ] **Step 1:** Escreva os testes. Rode `npx vitest run src/lib/bureaus/public.integration.test.ts src/middleware.test.ts`. Esperado: FAIL.
- [ ] **Step 2:** Implemente `public.ts`, a página e o middleware.
- [ ] **Step 3:** Rode o comando do Step 1. Esperado: PASS.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add "src/app/b/[slug]/page.tsx" src/lib/bureaus/public.ts src/lib/bureaus/public.integration.test.ts \
  src/middleware.ts src/middleware.test.ts
git commit -m "feat(public): add the /b/<slug> bureau page

Closes #21

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Domínio Titular, Sociedade, Dossiê e Consulta (closes #15, #16)

**Agent:** `backend-specialist` (`model: "sonnet"`)
**Depends-on:** 2
**Files:**
- Delete: `src/lib/clients/queries.ts`, `src/lib/batch/queries.ts`, `src/lib/company/queries.ts`, `src/actions/clients.ts`, `src/actions/company.ts`, `src/lib/validators/client.ts`
- Create: `src/lib/holders/queries.ts`, `src/lib/dossiers/queries.ts`, `src/actions/holders.ts`, `src/actions/dossiers.ts`, `src/lib/validators/holder.ts`
- Modify: `src/lib/consultations/{queries,service,canonical-store,view-model}.ts`, `src/lib/consultations/view-model.test.ts`, `src/lib/consultations/service.integration.test.ts`
- Modify: `src/lib/scr/queries.ts`, `src/lib/scr/queries.test.ts`, `src/lib/dashboard/queries.ts`, `src/lib/deps/products.ts`, `src/lib/deps/products.test.ts`
- Modify: `src/actions/{consultations,scr,scr-self,ai,portal}.ts`, `src/actions/portal.test.ts`, `src/actions/scr-self.test.ts`
- Modify: `src/types/app.ts` (tipos de domínio), `src/app/(portal)/layout.tsx`, `src/app/(portal)/portal/page.tsx`
- Rewrite: `src/lib/db/domain.integration.test.ts`

**Regras:** decisões 1, 6, 11 da spec; `01-ddd` (regra no módulo de domínio, não na action); "PoolClient não sai do módulo de queries" (exceto parâmetro, como `writeAuditEvent`).

**Interfaces:**

```ts
// holders/queries.ts
export type HolderInput = {
  type: EntityKind; name: string; document: string; email?: string | null; phone?: string | null;
  address?: string | null; addressNumber?: string | null; addressComplement?: string | null;
  neighborhood?: string | null; city?: string | null; state?: string | null; zipCode?: string | null; notes?: string | null;
};
export async function createHolder(identity: DbIdentity, input: HolderInput): Promise<{ ok: true; id: string } | { ok: false; reason: "duplicate_document" }>;
export async function updateHolder(identity: DbIdentity, id: string, input: HolderInput): Promise<{ ok: true } | { ok: false; reason: "not_found" | "duplicate_document" }>;
export async function ensureHolder(client: PoolClient, actorId: string, input: Pick<HolderInput, "type" | "name" | "document">): Promise<string>; // reusa por document_digits
export async function upsertPartnership(client: PoolClient, actorId: string, input: {
  companyId: string; partnerId: string; percentage: number | null; role: string | null; source: "deps" | "operator";
}): Promise<{ ok: true } | { ok: false; reason: "company_not_pj" | "self_link" }>;
export async function addHolderNote(identity: DbIdentity, holderId: string, content: string): Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
export async function listHolders(identity: DbIdentity, filters: { type?: EntityKind; q?: string }): Promise<HolderListItem[]>;
export async function getHolderDetail(identity: DbIdentity, id: string): Promise<HolderDetail | null>;
// HolderDetail: holder, companies (onde é sócio), partners (sócios), consultations, dossiers, timeline, notes.

// dossiers/queries.ts
export type DossierKindFilter = "PF" | "PJ" | "PJ_FULL";
export async function createDossier(identity: DbIdentity, input: {
  kind: DossierKindFilter;
  holder: Pick<HolderInput, "type" | "name" | "document">;
  partners?: { document: string; name: string | null; email: string | null; percentage: number | null; role: string | null }[];
  scrMode: "internal" | "deps"; email?: string | null;
}): Promise<{ ok: true; id: string; consultationIds: string[] } | { ok: false; reason: "kind_mismatch" }>;
export async function listDossiers(identity: DbIdentity, filters: { kind?: DossierKindFilter; q?: string }): Promise<DossierListItem[]>; // com members[]
export async function getDossierDetail(identity: DbIdentity, id: string): Promise<DossierDetail | null>;
export async function getDossierPdfDetail(identity: DbIdentity, id: string): Promise<DossierDetail | null>;
export async function saveDossierReport(identity: DbIdentity, id: string, report: DossierReport): Promise<void>;
export async function refreshDossierStatus(client: PoolClient, dossierId: string): Promise<void>; // status calculado das consultas
```

**Regras de negócio:**
- `holder.unique-per-bureau`: violação de `holders_document_unique` → `{ ok: false, reason: "duplicate_document" }`.
- `dossier.kind`: `PF` exige Titular PF; `PJ` e `PJ_FULL` exigem Titular PJ; senão `kind_mismatch`.
- `dossier.pj-full`: cria ou reusa a empresa e cada sócio (`ensureHolder`), grava a Sociedade (`source: "operator"`) e cria uma consulta por membro, todas com o mesmo `dossier_id`. Tudo em uma transação, com auditoria `dossier.create`.
- `partnership.from-deps`: consulta PJ concluída com quadro societário com documento → `upsertPartnership(source: "deps")` para cada sócio. Sem novas consultas.
- `consultation.belongs-to-dossier`: `runConsultation` sem `dossierId` cria um Dossiê `PF` ou `PJ`.
- `product.from-config`: `depsProductName(type)` lê `DEPS_PRODUTO_PF` / `DEPS_PRODUTO_PJ` e usa as constantes como padrão. Todo produto gravado vem dessa função; membros PF do `PJ_FULL` usam `depsProductName("PF")`.
- `portal.invite`: usa `createInvite` (Task 2) com papel `client` e o `bureauId` da identidade; liga `holders.client_profile_id` na mesma transação. `email_in_use` → "Este e-mail já pertence a outra conta."
- Timeline e notas usam `entity_type = 'holder'`.
- `lookupCnpj` vai de `actions/clients.ts` para `actions/holders.ts`, sem mudança de comportamento.

**Casos de teste (`domain.integration.test.ts`, `seedTenant` × 2):**
- `createHolder` grava Titular e evento `holder.created`; duplicado no mesmo Bureau → `duplicate_document`; mesmo documento no outro Bureau passa.
- `upsertPartnership`: empresa PF → `company_not_pj`; mesmo id → `self_link`; segunda chamada atualiza `%` sem duplicar.
- `createDossier PJ_FULL`: empresa + 2 sócios (um já existente) → 3 consultas, 2 Sociedades, sócio existente reusado.
- `createDossier PF` com Titular PJ → `kind_mismatch`.
- `listDossiers({ kind })` devolve só o tipo pedido, com `members`; nada do outro Bureau.
- `getHolderDetail` PF lista as empresas; PJ lista os sócios e os dossiês com `report_status`.
- `saveDossierReport` grava o parecer consolidado; `getDossierDetail` o devolve.
- `upsertSettings` como superadmin passa; como operador falha.
- `writeAuditEvent` grava o `bureau_id` da identidade e redige o documento.
- `getDashboardMetrics` conta só o próprio Bureau.
- `service.integration.test.ts`: consulta PJ com sócios no resultado cria Sociedades `source = 'deps'`.
- `products.test.ts`: env sobrescreve o nome; sem env, constantes.
- `portal.test.ts`, `scr-self.test.ts`, `scr/queries.test.ts`: mocks com a nova identidade; convite do portal com `email_in_use` devolve a mensagem.

- [ ] **Step 1:** Escreva os testes acima. Rode `npx vitest run src/lib/db/domain.integration.test.ts src/lib/consultations src/lib/scr src/lib/deps/products.test.ts src/actions`. Esperado: FAIL.
- [ ] **Step 2:** Implemente os módulos e reescreva as actions. Remova os arquivos da lista Delete.
- [ ] **Step 3:** Rode `npm run db:reset` e o comando do Step 1. Esperado: PASS.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add -A src/lib/clients src/lib/batch src/lib/company src/actions/clients.ts src/actions/company.ts \
  src/lib/validators/client.ts src/lib/validators/holder.ts src/lib/holders src/lib/dossiers \
  src/actions/holders.ts src/actions/dossiers.ts src/lib/consultations src/lib/scr src/lib/dashboard/queries.ts \
  src/lib/deps/products.ts src/lib/deps/products.test.ts \
  src/actions/consultations.ts src/actions/scr.ts src/actions/scr-self.ts src/actions/ai.ts src/actions/portal.ts \
  src/actions/portal.test.ts src/actions/scr-self.test.ts src/types/app.ts "src/app/(portal)" \
  src/lib/db/domain.integration.test.ts
git commit -m "refactor(domain): replace clients and batches with holders and dossiers

Closes #15
Closes #16

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Painel do superadmin — Bureaus, convite do admin, métricas, settings globais (closes #18)

**Agent:** `backend-specialist` (`model: "sonnet"`). Invoque `/vercel:shadcn` para os formulários.
**Depends-on:** 2
**Files:**
- Create: `src/lib/bureaus/queries.ts`, `src/lib/bureaus/queries.integration.test.ts`, `src/lib/validators/bureau.ts`, `src/lib/validators/bureau.test.ts`, `src/actions/bureaus.ts`
- Create: `src/app/(superadmin)/layout.tsx`, `src/app/(superadmin)/superadmin/page.tsx`, `src/app/(superadmin)/superadmin/bureaus/new/page.tsx`, `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx`, `src/app/(superadmin)/superadmin/settings/prompts/page.tsx`, `src/app/(superadmin)/superadmin/settings/scr/page.tsx`, `src/components/superadmin/*`
- Delete: `src/app/(dashboard)/settings/prompts/page.tsx`, `src/app/(dashboard)/settings/scr/page.tsx`
- Modify: `src/actions/settings.ts`, `src/components/settings/prompts-form.tsx`, `src/components/settings/scr-term-form.tsx`, `src/app/(dashboard)/layout.tsx`

**Interfaces:**

```ts
// validators/bureau.ts
export const bureauCreateSchema: z.ZodType<{ name: string; slug: string; adminName: string; adminEmail: string }>; // slug /^[a-z0-9-]{3,40}$/
export const bureauUpdateSchema: z.ZodType<{ id: string; name: string }>; // id uuid
// queries.ts
export async function createBureau(identity: DbIdentity, input: BureauCreate): Promise<
  { ok: true; id: string; adminEmail: string } | { ok: false; reason: "slug_taken" | "slug_reserved" | "email_in_use" }>;
export async function updateBureau(identity: DbIdentity, input: BureauUpdate): Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
export async function setBureauStatus(identity: DbIdentity, id: string, status: "active" | "inactive"): Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
export async function listBureauMetrics(identity: DbIdentity): Promise<BureauMetrics[]>; // platform_bureau_metrics()
export async function inviteBureauAdmin(identity: DbIdentity, input: { bureauId: string; name: string; email: string }): Promise<InviteOutcome>;
```

**Regras:**
- `bureau.create-atomic`: Bureau + `createInvite(role: "bureau_admin")` + auditoria `bureau.create` numa transação. `email_in_use` desfaz tudo. O e-mail sai depois do commit (`sendInviteEmail`); falha → mensagem "Bureau criado, mas o e-mail falhou. Use Reenviar convite."
- Violação de `bureaus_slug_not_reserved` → `slug_reserved`; de unicidade → `slug_taken`.
- O slug não muda depois de criado. A edição muda só o nome.
- Toda action exige `bureaus:manage`. Settings exigem `settings:write` para gravar.
- `(superadmin)/layout.tsx`: só papel `superadmin`; senão `redirect("/")`. Exige MFA como o painel.
- `(dashboard)/layout.tsx`: superadmin sem `supportSessionId` → `redirect("/superadmin")`.
- Métricas mostram só nome, slug, status e contagens.

**Casos de teste:**
- `bureau.test.ts`: slug válido; `"AB"`, `"ab"`, 41 caracteres, `"a_b"` inválidos; nome só com espaços inválido.
- `queries.integration.test.ts`: `createBureau` cria Bureau, perfil `bureau_admin` e auditoria com `bureau_id` nulo; slug `admin` → `slug_reserved`; slug repetido → `slug_taken`; e-mail de outro Bureau → `email_in_use` e nenhum Bureau criado; operador chamando `createBureau` falha; `setBureauStatus("inactive")` → `getPublicBureau` devolve `null`; `listBureauMetrics` devolve só as chaves esperadas (sem coluna pessoal); `saveAiPrompts` como `bureau_admin` devolve erro.

- [ ] **Step 1:** Escreva os testes. Rode `npx vitest run src/lib/bureaus/queries.integration.test.ts src/lib/validators/bureau.test.ts`. Esperado: FAIL.
- [ ] **Step 2:** Implemente queries, actions, páginas e a mudança de layout. Mova as telas de prompts e SCR.
- [ ] **Step 3:** Rode `npm run db:reset` e o comando do Step 1. Esperado: PASS.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add -A src/lib/bureaus/queries.ts src/lib/bureaus/queries.integration.test.ts src/lib/validators/bureau.ts \
  src/lib/validators/bureau.test.ts src/actions/bureaus.ts src/actions/settings.ts "src/app/(superadmin)" \
  src/components/superadmin src/components/settings/prompts-form.tsx src/components/settings/scr-term-form.tsx \
  "src/app/(dashboard)/settings/prompts" "src/app/(dashboard)/settings/scr" "src/app/(dashboard)/layout.tsx"
git commit -m "feat(superadmin): add bureau panel, first admin invite and metrics

Closes #18

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Equipe do Bureau — convite, ativação e papel (closes #20)

**Agent:** `backend-specialist` (`model: "sonnet"`)
**Depends-on:** 2
**Files:**
- Modify: `src/actions/users.ts`, `src/app/(dashboard)/settings/users/page.tsx`, `src/app/(dashboard)/settings/page.tsx`, `src/components/settings/create-user-form.tsx`, `src/components/settings/user-row-actions.tsx`
- Create: `src/actions/users.test.ts`

**Interfaces:**

```ts
export async function inviteTeamMember(input: { fullName: string; email: string; role: "bureau_admin" | "operator" }): Promise<{ error: string | null; email?: string }>;
export async function resendTeamInvite(input: { userId: string }): Promise<{ error: string | null }>;
export async function setUserRole(input: { userId: string; role: "bureau_admin" | "operator" }): Promise<{ error: string | null }>;
export async function setUserActive(input: { userId: string; isActive: boolean }): Promise<{ error: string | null }>;
```

**Regras:**
- Toda action: zod (`userId` uuid, papel do enum) → `getRequiredSession` → `hasPermission(session, "users:manage")`.
- `bureauId` vem de `session.bureauId`. O formulário não envia Bureau.
- O convite usa `createInvite` + `sendInviteEmail` (Task 2) e `invite.idempotent-resend`. Não copie `createConsultant`: remova a função.
- Ativar/desativar e mudar papel revogam as sessões do alvo, com auditoria no cliente da transação.
- O admin não desativa a si mesmo nem muda o próprio papel.
- `settings/page.tsx`: tira os links de prompts e SCR (vão para o superadmin, Task 5). O `bureau_admin` vê "Equipe", "Auditoria" e "Segurança".

**Casos de teste (`users.test.ts`, mocks no padrão de `portal.test.ts`):**
- Operador → erro de permissão; nenhuma query.
- `userId` não uuid e papel `superadmin` ou `client` → erro de validação.
- O convite usa `session.bureauId` mesmo com outro Bureau no input.
- `sendInviteEmail` falso → mensagem "Convite registrado, mas o e-mail falhou. Use Reenviar." e convite mantido.
- `email_in_use` → "E-mail já em uso."
- O admin tenta desativar a si mesmo → erro.

- [ ] **Step 1:** Escreva os testes. Rode `npx vitest run src/actions/users.test.ts`. Esperado: FAIL.
- [ ] **Step 2:** Implemente as actions e ajuste as telas.
- [ ] **Step 3:** Rode o comando do Step 1. Esperado: PASS.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add src/actions/users.ts src/actions/users.test.ts "src/app/(dashboard)/settings/users/page.tsx" \
  "src/app/(dashboard)/settings/page.tsx" src/components/settings/create-user-form.tsx \
  src/components/settings/user-row-actions.tsx
git commit -m "feat(team): bureau admin invites and manages its team

Closes #20

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Telas Pesquisas (Dossiês) e Titular PF/PJ (closes #17)

**Agent:** `frontend-specialist` (`model: "sonnet"`). Invoque `/vercel:nextjs`, `/vercel:shadcn` e `/ui-ux-pro-max`.
**Depends-on:** 4
**Files:**
- Delete: `src/app/(dashboard)/clients/**`, `src/app/(dashboard)/batch/**`, `src/app/(dashboard)/consultations/page.tsx`, `src/components/clients/**`, `src/components/batch/**`, `src/components/consultations/consultations-filters.tsx`
- Create: `src/app/(dashboard)/holders/{page,new/page,[id]/page,[id]/edit/page}.tsx`, `src/app/(dashboard)/dossiers/{page,new/page,[id]/page}.tsx`, `src/app/(dashboard)/dossiers/[id]/pdf/route.ts`, `src/components/holders/*`, `src/components/dossiers/*`, `src/components/dossiers/filters.ts`, `src/components/dossiers/filters.test.ts`
- Modify: `src/app/(dashboard)/page.tsx`, `src/app/(dashboard)/consultations/{new/page,[id]/page}.tsx`, `src/app/(dashboard)/consultations/[id]/pdf/route.ts`, `src/app/(dashboard)/scr/page.tsx`, `src/components/consultations/*`, `src/components/scr/*`, `src/components/layout/sidebar.tsx`, `src/lib/pdf/*`

**Interfaces:**

```ts
// components/dossiers/filters.ts
export function parseDossierFilter(tipo: string | undefined): DossierKindFilter | undefined; // "pf" | "pj" | "pj-completo"
export function dossierFilterParam(kind: DossierKindFilter | undefined): string | undefined;
```

**Regras:**
- Não edite `src/types/` nem `src/lib/*/queries.ts`. Falta dado → reporte `NEEDS_CONTEXT`.
- Sidebar: Dashboard, Pesquisas (`/dossiers`), Titulares (`/holders`), Autorizações SCR, Configurações.
- "Pesquisas": abas Todos | PF | PJ | PJ completo (`?tipo=`); cada Dossiê expande os membros (Titular, documento mascarado, status da consulta). Novo: "Consulta PF/PJ" → `/consultations/new`; "PJ completo" → `/dossiers/new`.
- Titular PF: "Empresas em que é sócio" (link para a empresa), consultas, dossiês. Titular PJ: "Sócios" (link, %, cargo), dossiês com parecer consolidado.
- O nome do produto chega do servidor (`depsProductName`). Sem literal "Smart PF 002" no formulário.
- PDF do Dossiê substitui o do lote (`company-process-document.tsx` vira `dossier-document.tsx`).
- Permissões com `hasPermission(session, …)`; identidade = `session`.

**Casos de teste:**
- `filters.test.ts`: `"pf"`, `"pj"`, `"pj-completo"` mapeiam; `undefined`, `""` e `"x"` → `undefined`; ida e volta com `dossierFilterParam`.
- O restante é apresentação: o gate é `npm run lint && npm run type-check && npm run build`, verde depois desta onda.

- [ ] **Step 1:** Escreva `filters.test.ts`. Rode `npx vitest run src/components/dossiers/filters.test.ts`. Esperado: FAIL.
- [ ] **Step 2:** Implemente telas, componentes, PDF e sidebar.
- [ ] **Step 3:** Rode o teste do Step 1 e `npm run lint && npm run type-check && npm run build`. Esperado: PASS.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add -A "src/app/(dashboard)/clients" "src/app/(dashboard)/batch" "src/app/(dashboard)/holders" \
  "src/app/(dashboard)/dossiers" "src/app/(dashboard)/consultations" "src/app/(dashboard)/scr/page.tsx" \
  "src/app/(dashboard)/page.tsx" src/components/clients src/components/batch src/components/holders \
  src/components/dossiers src/components/consultations src/components/scr src/components/layout/sidebar.tsx \
  src/lib/pdf
git commit -m "feat(ui): list research by dossier and add holder pages

Closes #17

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Modo suporte auditado (closes #19)

**Agent:** `backend-specialist` (`model: "sonnet"`)
**Depends-on:** 5
**Files:**
- Create: `src/lib/support/queries.ts`, `src/lib/support/queries.integration.test.ts`, `src/actions/support.ts`, `src/components/superadmin/support-start-form.tsx`, `src/components/layout/support-banner.tsx`
- Modify: `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx`, `src/app/(dashboard)/layout.tsx`, `src/lib/audit/read.ts`, `src/app/(dashboard)/settings/audit/page.tsx`

**Interfaces:**

```ts
export async function startSupportSession(identity: DbIdentity, input: { bureauId: string; reason: string }): Promise<
  { ok: true; id: string; expiresAt: Date } | { ok: false; reason: "bureau_not_found" | "invalid_reason" }>;
export async function endSupportSession(identity: DbIdentity): Promise<{ ok: true } | { ok: false; reason: "no_active_session" }>;
// actions/support.ts: zod (bureauId uuid, reason trim 1..500) → hasPermission(session, "support:enter").
// audit/read.ts: AuditLogRow ganha supportSessionId: string | null.
```

**Regras:**
- `support.single-open`: o início encerra (`ended_at = now()`) a sessão aberta do mesmo superadmin, na mesma transação.
- `support.audit`: início grava `support.start`; fim grava `support.end`. Os dois são eventos da plataforma (`bureau_id` nulo), `record_id` = sessão, `metadata` = `{ bureauId, reason }`.
- A identidade de início e fim é a da plataforma (sem `supportSessionId`). Depois do início, a próxima requisição carrega o suporte via `auth_profile_for_session`.
- Banner no `(dashboard)/layout.tsx` quando `session.support` existe: nome do Bureau, hora de expiração, botão "Encerrar suporte". Sem `support`, sem banner.
- Auditoria do Bureau mostra o selo "Suporte" nas linhas com `supportSessionId`. Página exige `audit:read` (papel `bureau_admin`).

**Casos de teste (`queries.integration.test.ts`):**
- Motivo vazio ou só espaços → `invalid_reason`; Bureau inexistente → `bureau_not_found`.
- Segundo início encerra o primeiro; só uma sessão aberta.
- Início e fim gravam `support.start` e `support.end` com `bureau_id` nulo.
- Com a sessão ativa, `withUserTransaction` do superadmin lê Titulares do Bureau alvo; a auditoria de uma escrita leva `support_session_id` e o `bureau_id` alvo.
- Sessão semeada com `expires_at` no passado → zero linhas.
- `bureau_admin` lê as linhas de suporte na sua auditoria; `listAuditLogs` devolve `supportSessionId`.

- [ ] **Step 1:** Escreva os testes. Rode `npx vitest run src/lib/support/queries.integration.test.ts`. Esperado: FAIL.
- [ ] **Step 2:** Implemente queries, actions, botão, banner e selo de auditoria.
- [ ] **Step 3:** Rode `npm run db:reset` e o comando do Step 1. Esperado: PASS.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add src/lib/support src/actions/support.ts src/components/superadmin/support-start-form.tsx \
  src/components/layout/support-banner.tsx "src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx" \
  "src/app/(dashboard)/layout.tsx" src/lib/audit/read.ts "src/app/(dashboard)/settings/audit/page.tsx"
git commit -m "feat(support): add audited support sessions for the superadmin

Closes #19

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Pipeline pós-implementação

Não são tasks. O controlador executa uma vez, depois da onda 4.

1. Rode `npm run lint`, `npm run type-check` e `npm run test` com o banco recriado. Corrija qualquer erro.
2. Rode o painel de review **uma vez** sobre o diff inteiro do M1 (`git diff main...HEAD`), em paralelo, num único lote. Cada revisor trabalha de forma independente:
   - `code-reviewer` (`model: "sonnet"`), com os critérios do skill `uncle-bob-craft`;
   - `security-reviewer` (`model: "sonnet"`), foco em RLS, SECURITY DEFINER, convites e modo suporte;
   - `feature-dev:code-reviewer` (`model: "sonnet"`), foco em TypeScript;
   - `database-architect` (`model: "sonnet"`), foco nos índices e políticas novos.
   Entregue a cada revisor a seção Review Focus.
3. Sintetize: junte duplicados, descarte achados sem cenário concreto de falha, classifique em CRITICAL/HIGH/MEDIUM/LOW.
4. Corrija CRITICAL e HIGH direto, com o especialista do domínio. MEDIUM/LOW seguem o corte do fluxo de review, sem nova rodada.
5. Abra o PR para `main` com `Closes #13` … `Closes #21` e a seção "Post-deploy follow-up".

## Post-deploy follow-up

Um item no corpo do PR. Não bloqueia o merge nem o fechamento das issues.

- (post-deploy) O e-mail de convite chega pelo SMTP de produção.
- (post-deploy) `EXPLAIN` das listagens de Pesquisas e Titulares usa os índices `bureau_id` com volume real.

## Cobertura das issues

| Issue | Task | Prova |
|---|---|---|
| #13 Bureaus e papéis | 1, 2 (closes) | `rls.integration` (perfil × Bureau), `permissions.test`, `bootstrap.integration` |
| #14 bureau_id + RLS | 1, 2 (closes) | `rls.integration`, `transaction.test` |
| #15 Titular e Sociedade | 4 | `domain.integration` (unicidade, Sociedade, portal) |
| #16 Dossiê e Consulta | 4 | `domain.integration` (PJ completo, parecer), `service.integration`, `products.test` |
| #17 Telas | 7 | `filters.test`, build |
| #18 Painel superadmin | 5 | `bureaus/queries.integration`, `bureau.test` |
| #19 Suporte auditado | 8 | `support/queries.integration` |
| #20 Equipe | 6 | `users.test`, `auth.integration` (MFA) |
| #21 `/b/<slug>` | 3 | `public.integration`, `middleware.test` (produtos: M2) |
