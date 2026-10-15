# Senha definida pelo administrador e troca obrigatória — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute com `superpowers:subagent-driven-development` em **ondas paralelas** (`Files:` / `Depends-on:`, regra `.claude/rules/08-parallel-subagent-driven-development.md`). Os implementadores **não fazem commit**: deixam as mudanças na árvore e reportam `Files changed`. O controlador faz um commit por task, na ordem do plano. Sem reviewer por task. Steps usam checkbox (`- [ ]`).

## Decisões

1. **Escopo.**
   - O superadmin escolhe a senha do primeiro admin em "Novo Bureau".
   - A página do Bureau tem "Definir senha" e "Forçar troca" para os admins desse Bureau (superadmin).
   - Na equipe, o `bureau_admin` escolhe a senha ao cadastrar um membro (`operator` ou `bureau_admin`).
   - Na equipe, o `bureau_admin` define a senha de um membro existente.
2. **Convite por e-mail continua opcional.** Campo de senha preenchido: crie o usuário com essa senha, sem e-mail. Campo em branco: comportamento atual (convite por e-mail).
3. **Troca obrigatória.**
   - Uma senha definida por outra pessoa é **temporária**: o perfil recebe `must_change_password = true`.
   - No login, o usuário vê **só** a tela de troca de senha (e "Sair") antes de qualquer outra página.
   - A troca limpa a flag e revoga as outras sessões do usuário.
   - A mesma flag pode ser ligada sem definir senha ("Forçar troca no próximo login").
4. **Regras de proteção (propostas pelo planejador).**
   - **Política de senha:** 12 a 128 caracteres, igual ao Better Auth (`minPasswordLength: 12`, `maxPasswordLength: 128` em `src/lib/auth/config.ts`; mesmo limite em `bootstrap.ts`). Um único schema zod (`src/lib/validators/password.ts`) serve todos os formulários e actions. `config.ts` passa a ler as constantes desse arquivo. Motivo: uma regra, um lugar.
   - **A senha nunca sai do caminho do hash.** Ela não vai para log, `audit_logs.metadata`, resposta ao cliente, `revalidatePath` nem URL. O SQL recebe só o hash (`hashPassword` de `better-auth/crypto`). Motivo: a senha temporária dá acesso à conta.
   - **Auditoria sem valor:** `user.password_set` e `user.force_password_change` registram quem definiu (ator) e para quem (`record_id`). A criação com senha grava `user.create_with_password`. A troca pelo próprio usuário grava `user.password_changed`. Motivo: rastrear sem expor.
   - **Definir senha ou forçar troca revoga todas as sessões do alvo.** Motivo: quem roubou uma sessão perde o acesso; "no próximo login" vale literalmente.
   - **Quem define a senha de quem:**
     - superadmin → só `bureau_admin` (de qualquer Bureau, indicado pelo Bureau da página);
     - `bureau_admin` → só `operator` do próprio Bureau;
     - nunca outro `bureau_admin` (tomada de conta entre pares), nunca o próprio usuário, nunca um superadmin, nunca um `client`.
     - O próprio usuário troca a senha em `/change-password` (senha atual + nova).
     - Motivo: quem define a senha consegue entrar na conta. Só um papel acima pode fazer isso.
   - **Criar membro com senha** (`bureau_admin` ou `operator`) é permitido. Motivo: conta nova, sem dados; a flag força a troca.
   - **Limite de tentativas:** não crie limitador novo.
     - A troca usa o endpoint HTTP `/api/auth/change-password` do Better Auth, que já tem o limite padrão de 3 pedidos por 10 s (armazenamento `database`).
     - O login com a senha temporária passa pelo limite de `/sign-in`.
     - As actions de administração exigem sessão com MFA, permissão (`bureaus:manage` ou `users:manage`) e geram auditoria.
     - Motivo: o limitador existente cobre as rotas que testam senha; as actions de admin não testam senha.
   - **Repetir a senha anterior:** não verifique. Motivo: decisão do usuário (não é requisito).
   - **Ordem no login:** login → MFA (verificação ou cadastro) → troca de senha.
     - Motivo: o Better Auth só emite sessão depois do TOTP para quem tem MFA. A troca exige sessão. O MFA vem primeiro em `getRequiredSessionFromHeaders` e o bloqueio da flag vem depois.
     - Consequência aceita: para uma conta nova, quem definiu a senha poderia cadastrar o MFA no lugar do dono. A auditoria `user.create_with_password` / `user.password_set` registra quem foi.
   - **Definir senha não reseta o MFA.** Um admin que perdeu o app autenticador fica fora deste escopo.

**Goal:** Deixar o superadmin e o `bureau_admin` definirem uma senha temporária (na criação ou depois) e forçar a troca no próximo login, sem e-mail.

**Architecture:** A coluna `profiles.must_change_password` entra em 003 (base editável). Uma função SECURITY DEFINER `admin_set_credentials` (dono `auth_profile_lookup`, em 009) valida quem chama e o alvo pelos GUCs, grava o hash em `account`, liga a flag e apaga as sessões. O trigger `protect_profile_identity` só aceita mudança da flag por esse gateway ou pelo próprio usuário (de `true` para `false`). `getRequiredSessionFromHeaders` lança `password_change_required` depois do MFA; todas as actions e rotas que usam a sessão negam. Os layouts redirecionam para `/change-password`. A troca usa o endpoint HTTP do Better Auth; um hook `after` limpa a flag.

**Tech Stack:** Next.js 14.2 (App Router), Better Auth 1.7.2, PostgreSQL 18.6 (RLS), node-postgres 8.21, zod, Vitest 4, shadcn/ui.

**Spec:** sem spec separada. A seção "Decisões" acima é a spec. Contexto: `docs/superpowers/specs/2026-10-14-m1-multitenant-design.md` (decisões 2, 7 e 9) e o plano `2026-10-14-m1-multitenant.md`.

## Global Constraints

- **Base editável:** edite `db/migrations/003_business.sql`, `004_rls.sql` e `009_public_scr_gateway_privileges.sql` no lugar. Não crie migration nova. Não existe banco implantado.
- Recrie o banco de dev antes dos testes de integração: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Testes de integração (`*.integration.test.ts`) rodam contra `127.0.0.1:54329` e usam `src/test/seed.ts`.
- Passe `session` (ou `DbIdentity`) inteiro como identidade. Use `platformIdentity(identity)` nas escritas do superadmin.
- `bureau_id` de escrita vem da identidade, nunca do formulário. Exceção: no superadmin, o Bureau vem do id da página; a função SQL valida o alvo contra ele.
- Server Actions: zod `safeParse` → `getRequiredSession` → `hasPermission` → query → `revalidatePath`. Retorno `{ error: string | null, ... }`. Erros de banco viram mensagem segura em pt-BR.
- A senha em texto puro só passa por zod e `hashPassword`. Nunca em `console.*`, mensagem de erro, auditoria, retorno, URL ou parâmetro de SQL.
- Identificadores e rotas em inglês (`/change-password`). Textos de UI, erros e comentários em pt-BR.
- **Gate da task:** os testes do escopo da task passam. `npm run lint && npm run type-check && npm run test` fica verde ao fim da onda 3.
- Implementadores: agente especialista com `model: "sonnet"`. Nunca `opus`.
- Commits: um por task, Conventional Commits, linha final `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Rode `git rev-parse --short HEAD` logo antes e registre o hash. `git add` só dos `Files:` da task.

## Review Focus

1. Tomada de conta pelo caminho de definir senha (par `bureau_admin`, outro Bureau, superadmin sobre superadmin, o próprio usuário) — Task 1: `admin_set_credentials target rules`; Task 2: `team: peer admin, self and other bureau are refused`.
2. Bypass da flag (rota, action ou layout acessível com `must_change_password = true`) — Task 2: `session.test.ts: flagged profile is blocked for every role`, `sessionErrorPath`; Task 3 usa `sessionErrorPath` nos 3 layouts.
3. Senha vazando para auditoria, log ou URL — Task 2: `audit never holds the password or the hash`.
4. Ordem do MFA burlada (troca liberando o painel sem TOTP) — Task 2: `session.test.ts: missing MFA wins over the flag`, `auth.integration: flagged user with MFA gets password_change_required`.
5. Reuso da senha temporária depois da troca — Task 2: `auth.integration: temporary password fails after the change; other sessions revoked`.

---

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `db/migrations/003_business.sql` | coluna `must_change_password`; slug reservado `change-password` | 1 |
| `db/migrations/004_rls.sql` | trigger protege a flag; `auth_profile_for_session` devolve a flag | 1 |
| `db/migrations/009_public_scr_gateway_privileges.sql` | grants e política do gateway; função `admin_set_credentials` | 1 |
| `src/lib/db/rls.integration.test.ts` | casos da função e do trigger | 1 |
| `src/lib/validators/password.ts` | schema zod único da senha | 2 |
| `src/lib/auth/credentials.ts` | definir senha, forçar troca, limpar a flag | 2 |
| `src/lib/auth/{session,authorization,invite,config}.ts` | bloqueio da flag, perfil, criação com senha, hooks do Better Auth | 2 |
| `src/lib/bureaus/queries.ts`, `src/lib/validators/bureau.ts`, `src/actions/{bureaus,users}.ts` | criação com senha e actions de credenciais | 2 |
| `src/app/(auth)/change-password/page.tsx`, layouts, `update-password/page.tsx` | tela de troca e redirecionamento | 3 |
| `src/components/auth/password-input.tsx`, `src/components/superadmin/*`, `src/components/settings/*`, página do Bureau | formulários com senha | 4 |

## Ondas

| Onda | Tasks | Por quê |
|---|---|---|
| 1 | 1 | coluna, trigger e função são a base |
| 2 | 2 | usa a função e a coluna |
| 3 | 3, 4 | dependem só da Task 2; arquivos disjuntos |

Depois de cada onda, o controlador faz os commits em ordem de número de task.

---

### Task 1: Coluna, trigger e gateway `admin_set_credentials`

**Agent:** `database-architect` (`model: "sonnet"`). Invoque `/postgresql-database-engineering`.
**Depends-on:** none
**Files:**
- Modify: `db/migrations/003_business.sql`, `db/migrations/004_rls.sql`, `db/migrations/009_public_scr_gateway_privileges.sql`
- Modify: `src/lib/db/rls.integration.test.ts`

**Regras:** `06-security` (menor privilégio, tomada de conta), `db/migrations/CLAUDE.md` (padrão SECURITY DEFINER: `set search_path = pg_catalog, public`, troca de dono, `revoke all … from public`, `grant execute … to app_runtime`), base editável. Decisão 4 (quem define a senha de quem).

**003 — forma exata:**

```sql
-- profiles: nova coluna, depois de mfa_enabled.
  must_change_password boolean not null default false,

-- bureaus_slug_not_reserved: acrescente 'change-password' à lista.
```

**004 — trigger `protect_profile_identity` (acrescente este bloco antes de `return new`):**

```sql
  -- A flag só muda pelo gateway admin_set_credentials ou pelo próprio usuário, de true para false.
  if old.must_change_password is distinct from new.must_change_password
     and current_user <> 'auth_profile_lookup'
     and not (old.must_change_password and not new.must_change_password
              and new.id = app_user_id()) then
    raise exception 'must_change_password changes only through the password flows';
  end if;
```

O trigger não é SECURITY DEFINER. Dentro de `admin_set_credentials`, `current_user` é `auth_profile_lookup`.

**004 — `auth_profile_for_session`:** acrescente `must_change_password boolean` ao fim de `returns table (…)` e `p.must_change_password` ao fim do `select`. O resto não muda.

**009 — grants e política (forma exata):**

```sql
-- Substitui a linha atual de select em profiles.
grant select (id, auth_user_id, role, is_active, mfa_enabled, bureau_id, must_change_password)
  on public.profiles to auth_profile_lookup;
grant update (must_change_password) on public.profiles to auth_profile_lookup;
grant select (user_id, provider_id), update (password, updated_at),
  insert (id, issuer, account_id, provider_id, user_id, password, updated_at)
  on public.account to auth_profile_lookup;
grant select (user_id), delete on public."session" to auth_profile_lookup;

create policy profiles_gateway_update on public.profiles for update to auth_profile_lookup
  using (role in ('bureau_admin', 'operator'))
  with check (role in ('bureau_admin', 'operator'));
```

Acrescente `admin_set_credentials` à lista de funções no comentário do topo de 009.

**009 — função (forma exata):**

```sql
-- Define a senha temporária (hash) e/ou liga must_change_password; apaga as sessões do alvo.
-- Quem chama: superadmin em contexto de plataforma, ou bureau_admin ativo no próprio Bureau.
-- Alvo: superadmin → bureau_admin de p_bureau_id; bureau_admin → operator do próprio Bureau.
-- false = alvo inexistente, de outro papel/Bureau, ou convite pendente sem hash (sem enumerar).
create function public.admin_set_credentials(
  p_target_id uuid,
  p_bureau_id uuid,
  p_password_hash text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text := public.app_user_role();
begin
  if public.app_user_id() is null
     or not exists (
       select 1 from public.profiles c
        where c.id = public.app_user_id() and c.role::text = v_role and c.is_active)
     or not (
       (v_role = 'superadmin' and public.app_bureau_id() is null)
       or (v_role = 'bureau_admin' and p_bureau_id = public.app_bureau_id())) then
    raise exception 'admin context required' using errcode = '42501';
  end if;

  perform 1 from public.profiles p
   where p.id = p_target_id
     and p.bureau_id = p_bureau_id
     and p.role::text = case v_role when 'superadmin' then 'bureau_admin' else 'operator' end
   for update;
  if not found then
    return false;
  end if;

  if p_password_hash is not null then
    update public.account set password = p_password_hash, updated_at = now()
     where user_id = p_target_id::text and provider_id = 'credential';
    if not found then
      insert into public.account (id, issuer, account_id, provider_id, user_id, password, updated_at)
      values (gen_random_uuid()::text, 'local:credential', p_target_id::text, 'credential',
              p_target_id::text, p_password_hash, now());
    end if;
  elsif not exists (
    select 1 from public.account a
     where a.user_id = p_target_id::text and a.provider_id = 'credential') then
    return false;
  end if;

  update public.profiles set must_change_password = true where id = p_target_id;
  delete from public."session" where user_id = p_target_id::text;
  return true;
end
$$;

alter function public.admin_set_credentials(uuid, uuid, text) owner to auth_profile_lookup;
revoke all on function public.admin_set_credentials(uuid, uuid, text) from public;
grant execute on function public.admin_set_credentials(uuid, uuid, text) to app_runtime;
```

O "nunca o próprio usuário" vem da regra de papel: um `bureau_admin` nunca é `operator`; um superadmin nunca tem `bureau_id`.

**Casos de teste (`rls.integration.test.ts`, tenants A e B via `seedTenant`, dois superadmins via `seedSuperadmin`; crie a linha `account` pelo dono quando o caso precisar de conta):**
- `admin_set_credentials target rules`:
  - superadmin (contexto de plataforma) + `bureau_admin` de A + `p_bureau_id = A` → `true`; hash gravado; flag `true`; sessões do alvo apagadas.
  - superadmin + `operator` de A → `false`. Superadmin + outro superadmin → `false`. Superadmin + admin de A com `p_bureau_id = B` → `false`.
  - superadmin com GUC `app.bureau_id` preenchido (suporte) → erro `42501`.
  - `bureau_admin` de A + `operator` de A → `true`. `bureau_admin` de A + outro `bureau_admin` de A → `false`. `bureau_admin` de A + ele mesmo → `false`.
  - `bureau_admin` de A + `p_bureau_id = B` → `42501`. `bureau_admin` de A + `operator` de B com `p_bureau_id = A` → `false`, B intacto.
  - `operator` e `client` chamando → `42501`. `bureau_admin` com `is_active = false` → `42501`.
  - hash nulo + alvo com conta → `true`, senha intacta, flag `true`. Hash nulo + convite pendente → `false`, flag intacta.
  - hash + convite pendente → cria `account` com `provider_id = 'credential'`, `account_id = user_id = id do alvo`.
- `trigger blocks flag writes`:
  - `bureau_admin` de A com `update profiles set must_change_password = …` no `operator` de A (ligar ou desligar) → erro.
  - usuário ligando a própria flag → erro. Usuário desligando a própria flag (de `true`) → passa.
- `auth_profile_for_session returns the flag`: depois de `admin_set_credentials`, a coluna `must_change_password` vem `true`.
- `change-password is a reserved slug`: insert em `bureaus` com slug `change-password` falha.

- [ ] **Step 1:** Escreva os casos acima em `rls.integration.test.ts`.
- [ ] **Step 2:** Rode `npm run db:reset` (DSN acima) e `npx vitest run src/lib/db/rls.integration.test.ts`. Esperado: FAIL (coluna e função não existem).
- [ ] **Step 3:** Edite 003, 004 e 009 conforme a especificação.
- [ ] **Step 4:** Rode `npm run db:reset` e o teste do Step 2. Esperado: PASS (os casos antigos também).
- [ ] **Step 5: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add db/migrations/003_business.sql db/migrations/004_rls.sql \
  db/migrations/009_public_scr_gateway_privileges.sql src/lib/db/rls.integration.test.ts
git commit -m "feat(db): add must_change_password and the admin_set_credentials gateway

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Senha temporária no servidor, bloqueio da flag e actions

**Agent:** `backend-specialist` (`model: "sonnet"`)
**Depends-on:** 1
**Files:**
- Create: `src/lib/validators/password.ts`, `src/lib/validators/password.test.ts`, `src/lib/auth/credentials.ts`, `src/lib/auth/session.test.ts`
- Modify: `src/lib/auth/session.ts`, `src/lib/auth/authorization.ts`, `src/lib/auth/invite.ts`, `src/lib/auth/config.ts`, `src/lib/auth/auth.integration.test.ts`
- Modify: `src/lib/validators/bureau.ts`, `src/lib/bureaus/queries.ts`, `src/lib/bureaus/queries.integration.test.ts`
- Modify: `src/actions/bureaus.ts`, `src/actions/users.ts`, `src/actions/users.integration.test.ts`

**Regras:** `06-security`, `src/lib/auth/CLAUDE.md` (novo código de falha = novo `SessionAccessError`; mudança de segurança revoga sessões), `src/actions/CLAUDE.md`, decisões 2, 3 e 4.

**Interfaces:**

```ts
// src/lib/validators/password.ts — sem dependência de servidor (os formulários importam).
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const passwordSchema: z.ZodString;
//   "A senha deve ter ao menos 12 caracteres." / "A senha deve ter no máximo 128 caracteres."
export const optionalPasswordSchema; // "" ou ausente → undefined; senão passwordSchema
export const newPasswordSchema;      // z.object({ password: passwordSchema, confirm: z.string() })
//   + refine: "As senhas não coincidem." em path ["confirm"]

// src/lib/auth/credentials.ts
export type CredentialsInput = { targetId: string; bureauId: string; password: string | null };
export type CredentialsOutcome = { ok: true } | { ok: false; reason: "not_found" };
export async function setTemporaryCredentials(
  client: PoolClient, actorId: string, input: CredentialsInput,
): Promise<CredentialsOutcome>;
export async function clearMustChangePassword(authUserId: string): Promise<void>;

// src/lib/auth/session.ts
// SessionAccessError ganha o código "password_change_required".
export function sessionErrorPath(error: unknown): "/mfa/setup" | "/change-password" | "/login";

// src/lib/auth/authorization.ts
// AuthProfile ganha mustChangePassword: boolean (de auth_profile_for_session).

// src/lib/auth/invite.ts
export type InviteInput = {
  email: string; fullName: string; role: "bureau_admin" | "operator" | "client";
  bureauId: string; password?: string;
};
// InviteOutcome não muda.

// src/lib/validators/bureau.ts — bureauCreateSchema ganha adminPassword: optionalPasswordSchema.

// src/lib/bureaus/queries.ts
export type CreateBureauResult =
  | { ok: true; id: string; adminEmail: string }
  | { ok: false; reason: "slug_taken" | "slug_reserved" | "email_in_use" }; // sem mudança
export async function inviteBureauAdmin(
  identity: DbIdentity, input: { bureauId: string; name: string; email: string; password?: string },
): Promise<InviteOutcome>;
export async function setBureauAdminCredentials(
  identity: DbIdentity, input: { bureauId: string; email: string; password: string | null },
): Promise<CredentialsOutcome>;

// src/actions/bureaus.ts
export async function setBureauAdminCredentials(values: unknown): Promise<BureauActionResult>;
//   values: { bureauId: uuid, email, password?: string } — password ausente = só forçar troca.
// inviteBureauAdmin: inviteSchema ganha password: optionalPasswordSchema.

// src/actions/users.ts
export async function inviteTeamMember(input: {
  fullName: string; email: string; role: "bureau_admin" | "operator"; password?: string;
}): Promise<{ error: string | null; email?: string; invited?: boolean }>;
export async function setTeamMemberCredentials(input: {
  userId: string; password?: string;
}): Promise<{ error: string | null }>;
```

**Regras de negócio:**
- `password.policy`: 12 a 128 caracteres. `config.ts` usa `PASSWORD_MIN_LENGTH` e `PASSWORD_MAX_LENGTH`. Não mude `bootstrap.ts`.
- `credentials.set`: `password` não nulo → `hashPassword` antes da primeira query → `select admin_set_credentials($1, $2, $3) as ok`. `ok = false` → `{ ok: false, reason: "not_found" }`. Auditoria no mesmo cliente: `user.password_set` (com senha) ou `user.force_password_change` (sem senha), `targetTable: "profiles"`, `targetId`, **sem `metadata`**.
- `credentials.clear`: `findAuthProfile(authUserId)`; perfil ausente → retorne. `withUserTransaction` com a identidade do próprio usuário (`userId`, `role`, `bureauId`, sem suporte). `update profiles set must_change_password = false where id = $1 and must_change_password`. `rowCount = 1` → auditoria `user.password_changed`. Erro: lance (não engula).
- `session.flag`: depois da checagem de MFA, `profile.mustChangePassword` → lance `password_change_required`. **Não revogue** a sessão (é estado de cadastro, como `mfa_setup_required`).
- `session.error-path`: `mfa_setup_required` → `/mfa/setup`; `password_change_required` → `/change-password`; qualquer outro erro → `/login`.
- `session.blocked-surface` (efeito do `session.flag`, sem código extra):
  - Layouts `(dashboard)`, `(portal)`, `(superadmin)` redirecionam (Task 3).
  - Todas as Server Actions de `src/actions/` que chamam `getRequiredSession` devolvem erro: `ai`, `bureaus`, `consultations`, `dossiers`, `holders`, `portal`, `scr`, `settings`, `support`, `users`.
  - Rotas `(dashboard)/consultations/[id]/pdf` e `(dashboard)/dossiers/[id]/pdf` devolvem 401.
  - Ficam livres: `actions/auth.ts` (`signOut`), `actions/scr-self.ts` (público por token), `/api/auth/*` (Better Auth: troca, 2FA, saída), `/api/health/*`, `/auth/callback` (só redireciona).
- `better-auth.hooks` em `config.ts`:
  - `emailAndPassword.onPasswordReset: async ({ user }) => clearMustChangePassword(user.id)`.
  - `hooks.after` (`createAuthMiddleware` de `better-auth/api`): só para `ctx.path === "/change-password"` com sucesso (`ctx.context.returned` existe e não é `APIError`). Leia o id em `returned.user.id`. Confirme a forma em `node_modules/better-auth/dist/api/routes/update-user.mjs`. Chame `clearMustChangePassword`.
  - Se `clearMustChangePassword` falhar depois da troca, a senha nova já vale. O usuário troca de novo usando a senha nova como atual. Aceito.
  - `authHandler` já força `revokeOtherSessions: true` em `/change-password`. Não mude.
- `invite.with-password`:
  - `password` + e-mail novo → `hashPassword` antes da primeira query; insira `user`, `account` (igual a `bootstrap.ts`: `issuer 'local:credential'`, `provider_id 'credential'`, `account_id = user_id = id`), `profiles` com `must_change_password = true`. Auditoria `user.create_with_password`, `metadata: { role, email }`.
  - `password` + e-mail existente do mesmo Bureau e papel → `already_member` (inclusive convite pendente: use "Definir senha"). Outro caso existente → `email_in_use`.
  - Sem `password` → comportamento atual, sem mudança.
- `bureau.create-with-password`: `adminPassword` preenchido → `createInvite` com `password`; a action **não** envia e-mail e devolve `{ error: null, id }`. Em branco → fluxo atual.
- `bureau.admin-credentials`: em `platformIdentity`, busque `select id from "user" where lower(email) = $1`. Sem linha → `not_found`. Com linha → `setTemporaryCredentials(client, actorId, { targetId, bureauId, password })`. Mensagem: "Administrador não encontrado neste Bureau." Permissão: `bureaus:manage`. Sem `revalidatePath`.
- `team.credentials`: `requireTeamManager`; `userId` uuid; `userId === session.userId` → "Use Trocar senha para a sua própria conta."; `not_found` → "Só é possível definir a senha de operadores do seu Bureau."; `revalidatePath("/settings/users")`.
- `team.invite-with-password`: senha preenchida → sem e-mail, retorno `{ error: null, email, invited: false }`. Em branco → fluxo atual com `invited: true`.

**Casos de teste:**
- `password.test.ts`: 11 caracteres falha; 12 passa; 128 passa; 129 falha; `optionalPasswordSchema("")` → `undefined`; `newPasswordSchema` com `confirm` diferente → erro em `confirm`.
- `session.test.ts` (mock de `./server`, `./authorization`, `@/lib/db/pool`; `now` injetado):
  - `flagged profile is blocked for every role`: superadmin, `bureau_admin`, `operator` com MFA e `client` sem MFA, todos com flag → `password_change_required`; `revokeUserSessions` não é chamado.
  - `missing MFA wins over the flag`: `operator` sem MFA e com flag → `mfa_setup_required`.
  - Sem flag → sessão devolvida.
  - `sessionErrorPath`: os 3 mapeamentos e um `Error` comum → `/login`.
- `auth.integration.test.ts` (reuse `authRequest`, `enable`, `loginWithMfa`, `login`):
  - `create with password then sign in`: `createInvite` com `password` (operator de A) → login com essa senha passa → sem MFA: `mfa_setup_required`.
  - `flagged user with MFA gets password_change_required`: depois de `enable`, `loginWithMfa` → `getRequiredSessionFromHeaders` rejeita com `password_change_required`.
  - `temporary password fails after the change; other sessions revoked`: duas sessões; `POST /api/auth/change-password` por `authHandler` com a primeira → 200; flag `false`; a segunda sessão sumiu; o cookie novo passa em `getRequiredSessionFromHeaders`; login com a senha temporária → falha; auditoria `user.password_changed`.
  - `set revokes target sessions`: alvo com sessão; `setTemporaryCredentials` (como `bureau_admin`) → 0 sessões; flag `true`; login com a senha nova passa.
  - `audit never holds the password or the hash`: em todas as linhas de `audit_logs` do alvo, `JSON.stringify(metadata)` não contém a senha nem o valor de `account.password`.
- `users.integration.test.ts`:
  - `bureau_admin` define a senha de um `operator` de A → `{ error: null }`, hash muda, flag `true`.
  - `team: peer admin, self and other bureau are refused`: outro `bureau_admin` de A, o próprio usuário, `operator` de B → erro; `account` e flag intactos.
  - `operator` chamando `setTeamMemberCredentials` → `NOT_ALLOWED`.
  - Forçar troca sem senha num convite pendente → erro; flag intacta.
  - `inviteTeamMember` com senha → `account` existe, flag `true`, `requestPasswordReset` (mock) não chamado, `invited: false`.
- `queries.integration.test.ts` (bureaus):
  - `createBureau` com `adminPassword` → `account` do admin existe, flag `true`.
  - `setBureauAdminCredentials`: admin do Bureau → `ok`; e-mail de `operator` → `not_found`; admin de outro Bureau com este `bureauId` → `not_found`; e-mail de superadmin → `not_found`; e-mail desconhecido → `not_found`.

- [ ] **Step 1:** Escreva os testes acima. Rode `npm run db:reset` e `npx vitest run src/lib/validators/password.test.ts src/lib/auth/ src/lib/bureaus/queries.integration.test.ts src/actions/users.integration.test.ts`. Esperado: FAIL.
- [ ] **Step 2:** Implemente os contratos e as regras acima.
- [ ] **Step 3:** Rode o comando do Step 1. Esperado: PASS. Rode `npm run type-check`. Esperado: só erros em arquivos das Tasks 3 e 4, ou nenhum.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add src/lib/validators/password.ts src/lib/validators/password.test.ts src/lib/auth/credentials.ts \
  src/lib/auth/session.ts src/lib/auth/session.test.ts src/lib/auth/authorization.ts \
  src/lib/auth/invite.ts src/lib/auth/config.ts src/lib/auth/auth.integration.test.ts \
  src/lib/validators/bureau.ts src/lib/bureaus/queries.ts src/lib/bureaus/queries.integration.test.ts \
  src/actions/bureaus.ts src/actions/users.ts src/actions/users.integration.test.ts
git commit -m "feat(auth): admin-set temporary passwords and forced password change

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tela de troca obrigatória e redirecionamento

**Agent:** `frontend-specialist` (`model: "sonnet"`). Invoque `/vercel:nextjs`.
**Depends-on:** 2
**Files:**
- Create: `src/app/(auth)/change-password/page.tsx`
- Modify: `src/app/(dashboard)/layout.tsx`, `src/app/(portal)/layout.tsx`, `src/app/(superadmin)/layout.tsx`
- Modify: `src/app/(auth)/update-password/page.tsx`

**Interfaces (consome da Task 2):** `sessionErrorPath(error)` de `@/lib/auth/session`; `newPasswordSchema` de `@/lib/validators/password`; `authClient.changePassword` de `@/lib/auth/client`; `signOut` de `@/actions/auth`.

**Regras:**
- Layouts: troque o `catch` atual por `redirect(sessionErrorPath(err))`. Nada mais muda.
- `/change-password`: página `"use client"` no grupo `(auth)`, no molde de `mfa/setup/page.tsx`. O middleware já exige o cookie de sessão; não mude `src/middleware.ts`.
- Formulário: "Senha atual", "Nova senha", "Confirmar nova senha" (`Input type="password"`, `autoComplete` `current-password` / `new-password`). Schema: `newPasswordSchema` mais `currentPassword: z.string().min(1, "Informe a senha atual.")`.
- Envio: `authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true })`. Sucesso → `window.location.href = "/"`.
- Erros: senha atual errada → "Senha atual incorreta."; HTTP 429 → "Muitas tentativas. Aguarde e tente de novo."; outro → "Não foi possível trocar a senha."
- Textos: título "Defina uma nova senha"; descrição "Sua senha foi definida por um administrador. Crie uma senha pessoal para continuar."; botão "Salvar nova senha"; botão "Sair" (`signOut`).
- `update-password/page.tsx`: troque o schema local por `newPasswordSchema`. O resto não muda.
- A senha nunca vai para a URL nem para o estado fora do formulário.

**Casos de teste:** sem teste novo. A lógica (`sessionErrorPath`, bloqueio da flag) está testada na Task 2. A página é apresentação e chama o Better Auth.

- [ ] **Step 1:** Implemente a página, os 3 layouts e o `update-password`.
- [ ] **Step 2:** Rode `npm run lint` e `npm run type-check`. Esperado: sem erro nos arquivos da task.
- [ ] **Step 3: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add "src/app/(auth)/change-password/page.tsx" "src/app/(dashboard)/layout.tsx" \
  "src/app/(portal)/layout.tsx" "src/app/(superadmin)/layout.tsx" "src/app/(auth)/update-password/page.tsx"
git commit -m "feat(auth): add the forced change-password screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Campos de senha nos formulários do superadmin e da equipe

**Agent:** `frontend-specialist` (`model: "sonnet"`). Invoque `/vercel:shadcn`.
**Depends-on:** 2
**Files:**
- Create: `src/components/auth/password-input.tsx`, `src/components/superadmin/admin-credentials-form.tsx`
- Modify: `src/components/superadmin/bureau-create-form.tsx`, `src/components/superadmin/invite-admin-form.tsx`, `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx`
- Modify: `src/components/settings/create-user-form.tsx`, `src/components/settings/user-row-actions.tsx`

**Interfaces (consome da Task 2):** actions `createBureau`, `inviteBureauAdmin`, `setBureauAdminCredentials` (`@/actions/bureaus`); `inviteTeamMember`, `setTeamMemberCredentials` (`@/actions/users`); `optionalPasswordSchema`, `newPasswordSchema`, `passwordSchema` (`@/lib/validators/password`); `bureauCreateSchema` com `adminPassword`.

```ts
// password-input.tsx — Input type password com botão "Mostrar"/"Ocultar" (aria-label e aria-pressed).
// forwardRef, aceita as props de Input (funciona com register do react-hook-form e com value/onChange).
export const PasswordInput: React.ForwardRefExoticComponent<InputProps & React.RefAttributes<HTMLInputElement>>;
```

**Regras:**
- Campo de senha opcional, sempre com "Confirmar senha" e `PasswordInput`. Dica: "Em branco: enviamos um convite por e-mail. Preenchida: o usuário entra com esta senha e troca no primeiro acesso."
- A confirmação é só da UI: o formulário estende o schema com `confirm` e o refine "As senhas não coincidem.". A action recebe só `password` (ou `adminPassword`).
- `bureau-create-form`: campos "Senha inicial do administrador (opcional)" e "Confirmar senha". Botão "Criar Bureau". Comportamento de sucesso e erro igual ao atual.
- `invite-admin-form`: mesmos campos opcionais; com senha, o sucesso mostra "Administrador criado. Ele troca a senha no primeiro acesso." em vez de "Convite enviado.".
- `admin-credentials-form` (`{ bureauId }`): título "Senha de um administrador"; campos "E-mail do administrador", "Nova senha temporária", "Confirmar senha". Botão "Definir senha" (exige senha) chama `setBureauAdminCredentials({ bureauId, email, password })`. Botão "Forçar troca no próximo login" chama a mesma action sem `password`. Sucesso: "Senha definida. As sessões do administrador foram encerradas." / "Troca de senha exigida no próximo login.".
- Página do Bureau: renderize `AdminCredentialsForm` depois de `InviteAdminForm`.
- `create-user-form`: campos opcionais de senha. Botão "Cadastrar". Sucesso com `invited: false`: "Usuário criado. Ele troca a senha no primeiro acesso." Com `invited: true`: mensagem atual.
- `user-row-actions`: só para `role === "operator"` e `!disabled`:
  - "Definir senha" abre um formulário na própria linha (nova senha + confirmar + "Salvar" / "Cancelar") e chama `setTeamMemberCredentials({ userId, password })`;
  - "Forçar troca" só quando `!pendingInvite`; chama `setTeamMemberCredentials({ userId })`.
  - Nenhum desses botões para `bureau_admin`.
- Limpe os campos de senha depois do envio. Nunca coloque a senha em URL, `console.*` ou estado fora do formulário.

**Casos de teste:** sem teste novo. O projeto não tem testes de componente. As regras de autorização estão no servidor (Tasks 1 e 2).

- [ ] **Step 1:** Implemente o componente e os formulários.
- [ ] **Step 2:** Rode `npm run lint` e `npm run type-check`. Esperado: sem erro.
- [ ] **Step 3:** Ao fim da onda 3, rode `npm run lint && npm run type-check && npm run test`. Esperado: verde.
- [ ] **Step 4: Commit**

```bash
git rev-parse --short HEAD   # registre o hash
git add src/components/auth/password-input.tsx src/components/superadmin/admin-credentials-form.tsx \
  src/components/superadmin/bureau-create-form.tsx src/components/superadmin/invite-admin-form.tsx \
  "src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx" \
  src/components/settings/create-user-form.tsx src/components/settings/user-row-actions.tsx
git commit -m "feat(ui): choose passwords when creating or managing admins and operators

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
