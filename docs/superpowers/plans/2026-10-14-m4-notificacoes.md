# M4 — Notificações Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute com `superpowers:subagent-driven-development` em **ondas paralelas** (`Files:` / `Depends-on:`, regra `.claude/rules/08-parallel-subagent-driven-development.md`). Os implementadores **não fazem commit**: deixam as mudanças na árvore e reportam `Files changed`. O controlador faz um commit por task, na ordem do plano. Sem reviewer por task. Steps usam checkbox (`- [ ]`).

**Goal:** Toda notificação entra numa outbox no Postgres, na transação da regra que a pede. Um worker chamado por cron envia por e-mail (SMTP) ou WhatsApp (Cloud API da Meta), tenta de novo com backoff e grava o log de entrega. O webhook da Meta atualiza o status. O e-mail de autorização SCR passa a sair pela fila.

**Architecture:** Uma migration nova, `019_notifications.sql`: templates versionados, outbox, eventos de entrega, opt-out e as funções que escrevem neles. A aplicação nunca escreve direto nessas tabelas. Camadas: Server Action ou query de domínio → `src/lib/notifications/queries.ts` (`enqueueNotification`, na transação do chamador) → função SQL. O worker (`POST /api/internal/notifications/dispatch`) e o webhook (`/api/webhooks/whatsapp`) usam o pool `app_webhook`, que só executa funções.

**Tech Stack:** Next.js 14.2, PostgreSQL 18.6 (RLS), node-postgres, zod, nodemailer, `fetch` nativo (Graph API), Vitest 4, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-14-m4-notificacoes-design.md`. Issues: #34 (parcial), #35, #36 (parcial). Base: a branch que tem as migrations 015–018 (M3b); crie `feature/m4-notificacoes` a partir dela, ou de `main` depois do merge do M3b. Aprovação: D1–D3 da spec vêm do usuário e são finais.

## Global Constraints

- Crie só `db/migrations/019_notifications.sql` (Task 1). Não edite as migrations 001–018. Recrie o banco de dev antes dos testes de integração: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Testes de integração (`*.integration.test.ts`) rodam contra `127.0.0.1:54329`. Cada task cria os helpers de teste no próprio arquivo de teste. Não edite `src/test/seed.ts`.
- Só as funções SQL da 019 escrevem em `notification_templates`, `notifications`, `notification_events` e `notification_opt_outs`. `app_runtime` não tem INSERT, UPDATE nem DELETE nelas. Funções `SECURITY DEFINER` fixam `search_path` e qualificam o schema. Copie o modelo de owner, política de gateway (`auth_profile_lookup`), `revoke` e `grant` das funções da 014–018.
- Worker e webhooks rodam só na role `app_webhook` (`getWebhookPool()`, `DATABASE_WEBHOOK_URL`). As funções do worker e do webhook têm `EXECUTE` só para `app_webhook`.
- `bureau_id` vem de `app_bureau_id()`, nunca do chamador.
- Auditoria no mesmo cliente da transação do enfileiramento (`writeAuditEvent`). Nunca destinatário, parâmetros, CPF/CNPJ, token, código SCR ou URL de autorização em `metadata`.
- Log da aplicação: só id da notificação, canal, estado e código de erro. Nunca corpo do webhook, destinatário, parâmetros, token de acesso ou resposta crua do provedor.
- Segredos (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `NOTIFICATIONS_DISPATCH_SECRET`, `SMTP_PASS`) só em variáveis de ambiente ou Docker secrets. Nunca no banco nem no repositório.
- Comparação de segredo e assinatura: `timingSafeEqual` sobre buffers do mesmo tamanho (modelo de `tokenMatches` do webhook do Asaas).
- Toda chamada ao provedor tem timeout de 10 s (`AbortSignal.timeout` na Graph API; `connectionTimeout`, `greetingTimeout` e `socketTimeout` no nodemailer).
- Server Actions: zod `safeParse` → `getRequiredSession` → `hasPermission` → query → `revalidatePath`; retorno `{ error: string | null, id? }`. Queries retornam `{ ok: false, reason }` para conflito de negócio.
- Identificadores em inglês. UI, erros e comentários em pt-BR.
- **Gate da task:** os testes do escopo da task passam. `npm run lint && npm run type-check && npm run test` passam no fim da última onda.
- Implementadores: agente especialista com `model: "sonnet"`. Nunca `opus`.
- Commits: um por task, Conventional Commits, `Closes #n` no corpo quando a task fecha a issue, linha final `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Rode `git rev-parse --short HEAD` antes e registre o hash. `git add` só dos `Files:` da task.

## Decisões deste plano que completam a spec

1. **Role do worker.** O worker usa `app_webhook`, não uma role nova. Ela continua sem privilégio em tabela e só ganha `EXECUTE` nas funções novas. Não precisa de segredo novo de banco.
2. **Templates por migration.** Sem editor na tela. A 019 semeia três templates: `scr_authorization` (e-mail v1, o HTML atual), `platform_test` (e-mail v1) e `platform_test` (WhatsApp v1, `hello_world`, `en_US`, sem parâmetros, que a Meta cria em todo WABA novo). Template novo da Meta entra por migration depois da aprovação.
3. **Cron.** Um serviço `notifications_cron` no `docker-stack.yml`, com a mesma imagem do app, roda `node scripts/notifications-cron.mjs`: chama a rota do worker a cada 60 s e espera a chamada anterior terminar. Sem crond novo, sem fila nova.
4. **Envio de teste.** O superadmin sem suporte enfileira `platform_test` para um destinatário que digita. A notificação tem `bureau_id` nulo. É o caminho da verificação real pós-deploy do WhatsApp.
5. **Driver fake.** `WHATSAPP_DRIVER=fake|meta`, como `ASAAS_DRIVER`. `fake` é proibido em produção. Sem configuração de WhatsApp, a notificação desse canal vira `failed` com `channel_not_configured` (nova tentativa manual depois de configurar).
6. **Seleção do template.** O enfileiramento fixa o `template_id` ativo. A nova tentativa usa a mesma versão.

## Review Focus

1. Dois workers e lease vencida — Task 1: `concurrent claims never return the same notification` e `stale lease result is ignored`.
2. Assinatura do webhook e reenvio da Meta — Task 4: `rejects missing, malformed and wrong X-Hub-Signature-256` e `duplicate status delivery changes nothing`.
3. Status fora de ordem e status antes do id — Task 1: `status never regresses` e `orphan status is adopted on complete`.
4. Telefone E.164 e nono dígito — Task 2: `toE164 normalizes and rejects` e `brazilianVariants`; Task 4: `opt-out matches wa_id without the ninth digit`.
5. Opt-out e LGPD — Task 1: `opted-out recipient is suppressed` e `payload is purged on terminal state`.
6. Nenhum dado pessoal ou CPF na outbox, no evento, na auditoria e no log — Task 1 (grant por coluna), Task 3 (`audit metadata has no recipient or params`), Task 4 (`never logs the body`).
7. Timeout do provedor — Task 2: `provider timeout is transient`; Task 3: `timeout reschedules with backoff`.
8. Template ausente, retirado ou rejeitado na Meta — Task 1: `template_not_found`; Task 2: `meta template errors are permanent template_unavailable`.
9. Isolamento entre Bureaus por RLS e `bureau_id` — Task 1: `bureau A never reads bureau B notifications or events`.

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `db/migrations/019_notifications.sql` | tabelas, índices, RLS, grants, funções, seeds | 1 |
| `src/lib/notifications/notifications.integration.test.ts` | idempotência, claim concorrente, lease, backoff, status, órfão, opt-out, purge, isolamento, grants | 1 |
| `src/lib/notifications/{types,recipient,render,errors}.ts` (+ testes) | tipos, E.164, máscara, render de e-mail, payload do WhatsApp, classificação de erro | 2 |
| `src/lib/notifications/channels/{email,whatsapp}.ts` (+ testes) | envio SMTP e Graph API (driver fake) | 2 |
| `src/lib/email/mailer.ts` (+ teste novo) | timeouts, `messageId` e header `Message-ID` | 2 |
| `src/lib/config.ts`, `src/lib/config.test.ts` | `readWhatsappConfig`, `readNotificationsDispatchSecret` | 2 |
| `src/lib/notifications/{queries,dispatch}.ts` (+ testes) | enfileirar, listar, nova tentativa, worker | 3 |
| `src/app/api/internal/notifications/dispatch/route.ts` (+ teste) | rota do worker | 3 |
| `src/actions/notifications.ts`, `src/lib/validators/notifications.ts` (+ teste) | ações do superadmin | 3 |
| `src/lib/db/permissions.ts`, `src/middleware.ts` (+ testes) | `notifications:manage`; rotas públicas do worker e do webhook | 3 |
| `src/lib/notifications/whatsapp-webhook.ts`, `src/app/api/webhooks/whatsapp/route.ts` (+ testes) | verificação, assinatura, status, opt-out | 4 |
| `src/actions/scr-self.ts`, `src/lib/scr/queries.ts`, `src/types/app.ts` (+ testes) | e-mail SCR pela fila; estado do último envio | 5 |
| `src/lib/email/scr-authorization-email.ts` | apagar (o HTML está no seed da 019) | 5 |
| `docker-stack.yml`, `Dockerfile`, `scripts/notifications-cron.mjs` (+ teste), `package.json`, `.github/workflows/ci.yml`, `src/lib/runtime-secrets.mjs` (+ teste), `scripts/setup/setup_production.py` (+ teste), `.env.example`, `docs/operations/notifications.md` | cron, segredos, operação | 6 |
| `src/app/(superadmin)/superadmin/notifications/page.tsx`, `src/components/notifications/*`, `src/components/superadmin/superadmin-nav.tsx`, `src/app/(dashboard)/scr/page.tsx`, `src/components/scr/scr-row-actions.tsx` | telas | 7 |

**Arquivos compartilhados e dono único:** `src/lib/config.ts` → Task 2. `src/lib/db/permissions.ts` e `src/middleware.ts` → Task 3 (inclui o caminho do webhook da Task 4). `src/lib/runtime-secrets.mjs`, `.env.example`, `package.json` e `ci.yml` → Task 6. `src/lib/notifications/types.ts` → Task 2.

## Ondas

| Onda | Tasks | Por quê |
|---|---|---|
| 1 | 1, 2, 6 | schema; código puro de canal; deploy e segredos. Contratos fixados neste plano; arquivos disjuntos |
| 2 | 3, 4 | usam as funções da Task 1 e os canais da Task 2; arquivos disjuntos |
| 3 | 5 | usa `enqueueNotification` da Task 3 |
| 4 | 7 | usa as queries e ações da Task 3 e o campo novo da Task 5 |

Review uma vez, no fim, sobre o diff inteiro: `code-reviewer` e `security-reviewer` (webhook assinado, segredo do worker, RLS, dados pessoais). Um review final em `opus` é permitido por tocar segurança; nunca como implementador.

---

### Task 1: Migration 019 — outbox, templates, eventos e opt-out

**Agent:** `database-architect` · `model: "sonnet"`
**Files:**
- Create: `db/migrations/019_notifications.sql`
- Create: `src/lib/notifications/notifications.integration.test.ts`

**Depends-on:** none

**Schema (forma exata):**

```sql
create table notification_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  channel text not null check (channel in ('email', 'whatsapp')),
  version integer not null check (version > 0),
  status text not null default 'active' check (status in ('active', 'retired')),
  -- Ordem = ordem dos parâmetros do corpo do template da Meta ({{1}}, {{2}}, ...).
  params text[] not null default '{}',
  email_subject text,
  email_html text,
  email_text text,
  wa_template_name text check (wa_template_name ~ '^[a-z0-9_]{1,512}$'),
  wa_language text check (wa_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  created_at timestamptz not null default now(),
  unique (key, channel, version),
  check (
    (channel = 'email' and email_subject is not null and email_html is not null and email_text is not null
      and wa_template_name is null and wa_language is null)
    or (channel = 'whatsapp' and wa_template_name is not null and wa_language is not null
      and email_subject is null and email_html is null and email_text is null)
  )
);
create unique index notification_templates_one_active on notification_templates (key, channel) where status = 'active';

create table notifications (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid references bureaus(id),            -- nulo: teste do superadmin
  template_id uuid not null references notification_templates(id),
  channel text not null check (channel in ('email', 'whatsapp')),
  recipient text,                                    -- apagado no estado final
  recipient_masked text not null check (length(recipient_masked) between 1 and 100),
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  params jsonb,                                      -- apagado com recipient
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  reference text check (reference is null or length(reference) <= 200),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'suppressed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  locked_until timestamptz,
  provider_message_id text unique,
  last_error_code text check (last_error_code is null or length(last_error_code) <= 64),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (bureau_id, idempotency_key),
  check (recipient is null or channel <> 'whatsapp' or recipient ~ '^\+[1-9][0-9]{7,14}$'),
  check (recipient is null or channel <> 'email' or recipient ~ '^[^@\s]+@[^@\s]+$'),
  check ((status = 'sending') = (lease_id is not null and locked_until is not null)),
  check (status not in ('pending', 'sending') or (recipient is not null and params is not null))
);
create index notifications_pending_due on notifications (next_attempt_at) where status = 'pending';
create index notifications_sending_lease on notifications (locked_until) where status = 'sending';
create index notifications_bureau_created on notifications (bureau_id, created_at desc, id desc);
create index notifications_reference on notifications (reference, created_at desc) where reference is not null;

create table notification_events (
  id bigint generated always as identity primary key,
  notification_id uuid references notifications(id),   -- nulo: status da Meta antes do id (órfão)
  bureau_id uuid references bureaus(id),
  kind text not null
    check (kind in ('queued', 'attempt_failed', 'sent', 'delivered', 'read', 'failed', 'suppressed', 'retried')),
  error_code text check (error_code is null or length(error_code) <= 64),
  provider_message_id text,
  dedupe_key text unique,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index notification_events_notification on notification_events (notification_id, id);
create index notification_events_orphan on notification_events (provider_message_id) where notification_id is null;

create table notification_opt_outs (
  channel text not null check (channel in ('email', 'whatsapp')),
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('whatsapp_keyword')),
  created_at timestamptz not null default now(),
  primary key (channel, recipient_hash)
);
```

- `notification_recipient_hash(p text) returns text` (`immutable`): `encode(sha256(convert_to(p, 'UTF8')), 'hex')`. Todo hash da 019 passa por ela.
- Triggers: `notification_templates` só aceita UPDATE de `status` de `active` para `retired`; nenhum DELETE. `notification_events` só aceita UPDATE que preenche `notification_id` e `bureau_id` quando eram nulos (adoção de órfão); nenhum DELETE. `notifications` sem DELETE.

**Claim do worker (forma exata):**

```sql
create function claim_notifications(p_limit integer)
returns table (
  id uuid, lease_id uuid, channel text, recipient text, params jsonb, attempts integer, opted_out boolean,
  template_key text, template_version integer, template_params text[],
  email_subject text, email_html text, email_text text, wa_template_name text, wa_language text
)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  -- Lease vencida sem tentativa sobrando: falha final (o processo caiu na última tentativa).
  update public.notifications n
     set status = 'failed', last_error_code = 'lease_expired', lease_id = null, locked_until = null, updated_at = now()
   where n.status = 'sending' and n.locked_until < now() and n.attempts >= n.max_attempts;

  -- Retenção: failed guarda destinatário e parâmetros por 7 dias para a nova tentativa manual.
  update public.notifications n
     set recipient = null, params = null
   where n.status = 'failed' and n.recipient is not null and n.updated_at < now() - interval '7 days';

  return query
  with picked as (
    select n.id
      from public.notifications n
     where (n.status = 'pending' and n.next_attempt_at <= now())
        or (n.status = 'sending' and n.locked_until < now() and n.attempts < n.max_attempts)
     order by n.next_attempt_at
     limit least(greatest(coalesce(p_limit, 1), 1), 50)
     for update skip locked
  ), claimed as (
    update public.notifications n
       set status = 'sending', lease_id = gen_random_uuid(), locked_until = now() + interval '2 minutes',
           attempts = n.attempts + 1, updated_at = now()
      from picked
     where n.id = picked.id
    returning n.id, n.lease_id, n.channel, n.recipient, n.params, n.attempts, n.template_id, n.recipient_hash
  )
  select c.id, c.lease_id, c.channel, c.recipient, c.params, c.attempts,
         exists (select 1 from public.notification_opt_outs o
                  where o.channel = c.channel and o.recipient_hash = c.recipient_hash),
         t.key, t.version, t.params, t.email_subject, t.email_html, t.email_text, t.wa_template_name, t.wa_language
    from claimed c
    join public.notification_templates t on t.id = c.template_id;
end;
$$;
```

**Contrato das demais funções:**
- `enqueue_notification(p_template_key text, p_channel text, p_recipient text, p_recipient_masked text, p_params jsonb, p_idempotency_key text, p_reference text)` → `(ok boolean, reason text, notification_id uuid, duplicate boolean)`. `EXECUTE` para `app_runtime`.
  - Quem pode: `bureau_admin` e `operator` com `app_bureau_id()`; superadmin em suporte (Bureau da sessão); superadmin sem suporte (Bureau nulo). `client` e contexto ausente: `not_allowed`.
  - Template ativo por chave e canal; sem ele: `template_not_found`.
  - `p_params` é objeto JSON, só valores string, e o conjunto de chaves é igual a `template.params`; senão `invalid_params`.
  - Destinatário que falha a CHECK do canal: `invalid_recipient` (capture a violação, não deixe a exceção subir).
  - `insert ... on conflict (bureau_id, idempotency_key) do nothing`. Conflito: devolve o id existente com `duplicate = true` e não grava evento. Novo: grava o hash com `notification_recipient_hash(p_recipient)` e o evento `queued`.
- `complete_notification(p_notification_id uuid, p_lease_id uuid, p_outcome text, p_provider_message_id text, p_error_code text)` → `text` (`applied | stale`). `EXECUTE` só para `app_webhook`.
  - Só altera a linha com o mesmo `lease_id` e `status = 'sending'`; senão `stale` (lease velha nunca sobrescreve).
  - `sent`: `status = 'sent'`, `sent_at`, `provider_message_id`, apaga `recipient` e `params`, evento `sent`. Depois adota os eventos órfãos com o mesmo `provider_message_id` e aplica o maior status deles pela regra `StatusOnlyAdvances`.
  - `retry`: se `attempts >= max_attempts`, vira `failed`; senão `status = 'pending'` e `next_attempt_at = now() + least(power(2, attempts - 1) * interval '1 minute', interval '60 minutes')`. Evento `attempt_failed` com o código.
  - `failed`: `status = 'failed'`, evento `failed` com o código. `recipient` e `params` ficam (retenção de 7 dias).
  - `suppressed`: `status = 'suppressed'`, apaga `recipient` e `params`, evento `suppressed`.
  - Toda saída de `sending` limpa `lease_id` e `locked_until` e grava `last_error_code` quando houver.
- `apply_whatsapp_status(p_provider_message_id text, p_status text, p_error_code text, p_occurred_at timestamptz)` → `text` (`applied | duplicate | orphan | ignored`). `EXECUTE` só para `app_webhook`.
  - Grava o evento com `dedupe_key = 'meta:' || p_provider_message_id || ':' || p_status` e `on conflict do nothing`; sem linha nova: `duplicate`.
  - Sem notificação com esse id: o evento fica com `notification_id` nulo: `orphan`.
  - **StatusOnlyAdvances:** ordem `sent < delivered < read`. `delivered` e `read` aplicam só se maiores que o estado atual. `failed` aplica só sobre `sent` e grava `last_error_code`. O resto: `ignored` (o evento fica no log). Status aplicado apaga `recipient` e `params`.
- `record_notification_opt_out(p_channel text, p_recipient text)` → `void`. `EXECUTE` só para `app_webhook`. `on conflict do nothing`.
- `retry_notification(p_notification_id uuid)` → `(ok boolean, reason text)`. `EXECUTE` para `app_runtime`. Só superadmin sem suporte (`not_allowed`); só `failed` (`invalid_state`); exige `recipient` não nulo (`payload_purged`). Volta para `pending`, `attempts = 0`, `next_attempt_at = now()`, evento `retried`.

**RLS e grants:**
- As quatro tabelas com `enable` e `force row level security`.
- `notifications` e `notification_events`: SELECT para `bureau_admin` e `operator` do próprio Bureau (`bureau_id = app_bureau_id()` e `app_is_staff()`) e para o superadmin sem suporte (todas as linhas, exceção estreita, só SELECT). `client`: nada.
- Grant por coluna para `app_runtime` em `notifications`: `id, bureau_id, template_id, channel, recipient_masked, reference, status, attempts, max_attempts, next_attempt_at, last_error_code, created_by, created_at, sent_at, updated_at`. **Sem** `recipient`, `params`, `recipient_hash`, `idempotency_key`, `lease_id`, `provider_message_id`. Em `notification_events`: todas as colunas menos `dedupe_key` e `provider_message_id`.
- `notification_templates`: SELECT só para o superadmin sem suporte. `notification_opt_outs`: nenhum grant para `app_runtime`.
- `app_webhook`: nenhum grant de tabela.

**Seeds:**
- `scr_authorization`, e-mail, v1, `params = {clientName, authorizedName, code, url}`: copie assunto, HTML e texto de `buildScrAuthorizationEmail` (`src/lib/email/scr-authorization-email.ts`) com os marcadores `{{clientName}}`, `{{authorizedName}}`, `{{code}}`, `{{url}}` no lugar das interpolações. Não mude cores, textos nem estrutura.
- `platform_test`, e-mail, v1, sem parâmetros: assunto "Teste de envio — Plataforma Bureau" e corpo curto.
- `platform_test`, WhatsApp, v1: `hello_world`, `en_US`, sem parâmetros.

**Testes (casos mínimos):**
- `enqueue_notification`: cria com evento `queued`; mesma chave no mesmo Bureau devolve `duplicate` sem linha nem evento novo; mesma chave em outro Bureau cria outra linha; `template_not_found` (chave inexistente e template `retired`); `invalid_params` (chave a mais, a menos, valor não string); `invalid_recipient` (telefone sem `+`, e-mail sem `@`); `client` recebe `not_allowed`; o `bureau_id` gravado é o da sessão.
- `concurrent claims never return the same notification` (duas conexões `app_webhook`, 30 linhas, lote de 20).
- Claim incrementa `attempts`, cria lease e respeita `next_attempt_at` futuro.
- `stale lease result is ignored`: lease vencida, novo claim, o `complete` com a lease antiga devolve `stale`.
- Lease vencida na última tentativa vira `failed` com `lease_expired`.
- Backoff: `retry` na tentativa 1, 2 e 7 agenda 1, 2 e 60 minutos; a 8ª falha vira `failed`.
- `status never regresses`: `read` depois `delivered` mantém `read`; `failed` depois de `delivered` é `ignored`; evento repetido é `duplicate`.
- `orphan status is adopted on complete`: `delivered` antes do `sent` fica órfão; `complete(sent)` adota e o estado final é `delivered`.
- `opted-out recipient is suppressed`: o claim devolve `opted_out = true`.
- `payload is purged on terminal state`: `sent`, `suppressed` e status da Meta apagam `recipient` e `params`; `failed` mantém até 7 dias e o claim apaga depois.
- `retry_notification`: só superadmin sem suporte, só `failed`, `payload_purged` depois da retenção.
- `bureau A never reads bureau B notifications or events`; staff recebe erro de permissão ao ler `recipient` ou `params`; `client` não lê nada.
- `app_runtime` não faz INSERT/UPDATE/DELETE direto e não executa `claim_notifications`, `complete_notification`, `apply_whatsapp_status` nem `record_notification_opt_out`. `app_webhook` não faz SELECT direto em nenhuma das quatro tabelas.
- Templates: UPDATE do corpo falha; `active → retired` passa; dois ativos para a mesma chave e canal falham.

- [ ] Escreva os testes (vermelhos).
- [ ] Escreva a migration e rode `npm run db:reset` com a URL do dono.
- [ ] Rode `npx vitest run src/lib/notifications/notifications.integration.test.ts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 2: Canais, render, telefone e configuração

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/notifications/types.ts`
- Create: `src/lib/notifications/recipient.ts`, `src/lib/notifications/recipient.test.ts`
- Create: `src/lib/notifications/render.ts`, `src/lib/notifications/render.test.ts`
- Create: `src/lib/notifications/errors.ts`, `src/lib/notifications/errors.test.ts`
- Create: `src/lib/notifications/channels/email.ts`, `src/lib/notifications/channels/email.test.ts`
- Create: `src/lib/notifications/channels/whatsapp.ts`, `src/lib/notifications/channels/whatsapp.test.ts`
- Modify: `src/lib/email/mailer.ts`; Create: `src/lib/email/mailer.test.ts`
- Modify: `src/lib/config.ts`, `src/lib/config.test.ts`

**Depends-on:** none (contrato da Task 1 fixado acima)

**Contrato:**
- `types.ts`: `NotificationChannel = "email" | "whatsapp"`; `ClaimedNotification` (espelha as colunas de `claim_notifications`, `params: Record<string, string>`); `SendResult = { ok: true; providerMessageId: string } | { ok: false; permanent: boolean; code: string }`.
- `recipient.ts`:
  - `toE164(input: string): string | null`. **E164Br:** remova espaço, parêntese, hífen e ponto. Com `+`: 8 a 15 dígitos, primeiro dígito diferente de 0. Sem `+`: 10 ou 11 dígitos são número brasileiro (DDD de 11 a 99, sem 0 em nenhum dígito; com 11 dígitos, o terceiro é 9) e ganham `+55`; 12 ou 13 dígitos começando com `55` seguem a mesma regra depois do `55`. Prefixo de operadora (`0` inicial) e qualquer outro caso: `null`.
  - `brazilianVariants(e164: string): string[]`: para `+55` com celular, devolve as formas com e sem o nono dígito; para o resto, `[e164]`.
  - `normalizeEmail(input: string): string | null`: `trim`, minúsculas, `isValidEmail` de `src/lib/utils.ts`.
  - `maskRecipient(channel, recipient)`: e-mail reusa `maskRecipient` de `src/lib/auth/email.ts`; telefone mostra DDI e os 4 últimos dígitos (`+55*******5615`).
- `render.ts`:
  - `renderEmail(template, params) → { subject, html, text }`. Marcador `{{nome}}` (`/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g`). No HTML, o valor passa por escape de `& < > " '`. No assunto, CR e LF saem. Marcador sem parâmetro: `TemplateRenderError` (permanente, `template_render_error`).
  - `buildWhatsappPayload(template, params, to)` → corpo da Graph API: `messaging_product: "whatsapp"`, `to` sem o `+`, `type: "template"`, `template: { name, language: { code }, components }`. Com parâmetros, um componente `body` com `parameters` na ordem de `template.params` (`{ type: "text", text }`). Sem parâmetros, sem `components`.
  - `validateWhatsappParams(params)`: valor sem quebra de linha, sem tab, sem mais de 4 espaços seguidos, até 1024 caracteres (regra da Meta). Falha: `invalid_params`.
- `errors.ts`: `classifySmtpError(error)` e `classifyGraphError(status, body | null, error | null)` → `{ permanent, code }`.
  - SMTP: `responseCode` 5xx → permanente `smtp_rejected`; 4xx, `ETIMEDOUT`, `ECONNECTION`, `ESOCKET` → transitório.
  - Graph: timeout, erro de rede, HTTP 429 e 5xx → transitório. Códigos de template ausente, pausado, desativado ou parâmetro errado (132000, 132001, 132005, 132007, 132012, 132015, 132016) → permanente `template_unavailable`. Destinatário sem WhatsApp (131026) → permanente `recipient_unavailable`. Limite de taxa (130429, 131056) → transitório. Token inválido (190) → transitório `config_error`. **Confira os códigos na documentação vigente da Meta** e registre num comentário curto o que conferiu.
- `channels/email.ts`: `sendEmailNotification(notification) → SendResult`. Usa `renderEmail` e `sendMail`. `Message-ID` = `<{notification.id}@{domínio do remetente}>`.
- `channels/whatsapp.ts`: `sendWhatsappNotification(notification) → SendResult`. `POST {graphBaseUrl}/{graphVersion}/{phoneNumberId}/messages` com `Authorization: Bearer`, `AbortSignal.timeout(10_000)`; devolve `messages[0].id`. Driver `fake`: devolve `fake-wamid-<uuid>` sem rede. Sem configuração: `{ ok: false, permanent: true, code: "channel_not_configured" }`.
- `mailer.ts`: `sendMail` ganha `connectionTimeout`, `greetingTimeout` e `socketTimeout` de 10 s, aceita `messageId` opcional e devolve `{ messageId }`. Mantenha `readConfig`.
- `config.ts`:
  - `readWhatsappConfig(env)` → `null | { driver: "fake"; phoneNumberId; appSecret; verifyToken } | { driver: "meta"; accessToken; phoneNumberId; appSecret; verifyToken; graphBaseUrl; graphVersion }`. O webhook (Task 4) compara `phoneNumberId` nos dois drivers. `WHATSAPP_DRIVER` vazio → `null`. `fake` em produção falha. `WHATSAPP_VERIFY_TOKEN` e `WHATSAPP_APP_SECRET` com 32 caracteres ou mais. `WHATSAPP_PHONE_NUMBER_ID` só dígitos. `WHATSAPP_GRAPH_VERSION` em `^v\d+\.\d+$`. `WHATSAPP_GRAPH_BASE_URL` padrão `https://graph.facebook.com`, só `https`.
  - `readNotificationsDispatchSecret(env)`: `NOTIFICATIONS_DISPATCH_SECRET` obrigatório, 32 caracteres ou mais, diferente do valor de exemplo `local-dispatch-secret-0123456789abcdef` em produção.
  - As duas ficam fora de `readConfig` (lidas sob demanda, como `readAsaasConfig`).

**Testes (casos mínimos):**
- `toE164 normalizes and rejects`: `(63) 9 9234-5615`, `63992345615`, `5563992345615`, `+55 63 99234-5615` → `+5563992345615`; `6332345615` → `+556332345615`; `+14155550123` passa; `0636399234561`, `639923456`, `+0123`, `00992345615`, `6382345615` com 11 dígitos sem 9 → `null`.
- `brazilianVariants`: celular brasileiro devolve as duas formas; fixo e número estrangeiro devolvem um.
- Render: escape de `<script>` e de aspas no HTML; texto sem escape; assunto sem CR/LF; marcador ausente lança `TemplateRenderError`; o seed SCR renderizado contém o código e a URL.
- Payload do WhatsApp: ordem dos parâmetros; sem `components` quando vazio; `to` sem `+`; quebra de linha no valor é recusada.
- `provider timeout is transient` (SMTP e Graph); `meta template errors are permanent template_unavailable`; 429 e 5xx transitórios; 131026 permanente.
- WhatsApp: driver fake não chama `fetch`; resposta da Meta sem `messages[0].id` é transitória `invalid_response`; o token nunca aparece em erro nem em log.
- `config`: cada regra de `readWhatsappConfig` e de `readNotificationsDispatchSecret`.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/notifications/recipient.test.ts src/lib/notifications/render.test.ts src/lib/notifications/errors.test.ts src/lib/notifications/channels src/lib/email src/lib/config.test.ts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 3: Serviço da fila, worker e ações do superadmin

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/notifications/queries.ts`, `src/lib/notifications/queries.integration.test.ts`
- Create: `src/lib/notifications/dispatch.ts`, `src/lib/notifications/dispatch.integration.test.ts`
- Create: `src/app/api/internal/notifications/dispatch/route.ts`, `src/app/api/internal/notifications/dispatch/route.test.ts`
- Create: `src/lib/validators/notifications.ts`, `src/actions/notifications.ts`, `src/actions/notifications.test.ts`
- Modify: `src/lib/db/permissions.ts`, `src/lib/db/permissions.test.ts`
- Modify: `src/middleware.ts`, `src/middleware.test.ts`

**Depends-on:** 1, 2

**Contrato:**
- `queries.ts`:
  - `enqueueNotification(client: PoolClient, identity: DbIdentity, input: { templateKey: string; channel: NotificationChannel; recipient: string; params: Record<string, string>; idempotencyKey: string; reference?: string }) → { ok: true; id: string; duplicate: boolean } | { ok: false; reason: "invalid_recipient" | "invalid_params" | "template_not_found" | "not_allowed" }`.
    - Normaliza com `toE164` ou `normalizeEmail`; `null` → `invalid_recipient` sem chamar o banco.
    - WhatsApp: `validateWhatsappParams`.
    - **NoDocumentInPayload:** recusa (`invalid_params`) chave de parâmetro que casa com o padrão de chave sensível da auditoria (`cpf`, `cnpj`, `document`, `token`, `password`...). Exporte o padrão de `src/lib/audit/write.ts` só se precisar; não copie a regex.
    - Chama `enqueue_notification` no `client` recebido. Se `ok` e não `duplicate`: `writeAuditEvent(client, { actorId: identity.userId, action: "notification.enqueue", targetTable: "notifications", targetId: id, metadata: { templateKey, channel } })`.
    - Não abre transação própria: o chamador decide.
  - `listNotifications(identity, { status?, channel?, limit, cursor })` → linhas com as colunas do grant e `templateKey`; cursor por `(created_at, id)`; `limit` máximo 100.
  - `listTemplates(identity)` → chave, canal, versão, estado, `wa_template_name`, `wa_language`, parâmetros (sem corpo).
  - `retryNotification(identity, id)` → `{ ok: true } | { ok: false, reason }`, com auditoria `notification.retry` na mesma transação.
  - `getLatestNotificationStatus` não é preciso: a Task 5 faz o join na query SCR.
- `dispatch.ts`: `runDispatch({ budgetMs = 45_000, batchSize = 10 }) → { claimed, sent, retried, failed, suppressed }`.
  - Laço: `claim_notifications(batchSize)` no pool `app_webhook` → para cada linha, em paralelo dentro do lote (`Promise.allSettled`): `opted_out` → `complete(suppressed)` sem chamar o provedor; senão o canal da Task 2 → `complete(sent | retry | failed)`. Para quando o lote vem vazio ou o tempo passa de `budgetMs`.
  - Exceção não esperada no envio → `retry` com `unexpected_error`. `complete` que devolve `stale` só conta; nunca lança.
  - Log por lote: contagens. Por falha: id, canal, código. Nada mais.
- Rota `POST /api/internal/notifications/dispatch`: `export const dynamic = "force-dynamic"`. Configuração ausente → 500. `Authorization` diferente de `Bearer <segredo>` (comparação com hash e `timingSafeEqual`) → 401. Sucesso → 200 com o JSON das contagens. Outro método → 405.
- Permissão `notifications:manage` só para `superadmin` (sem suporte, pela regra existente).
- Ações (`src/actions/notifications.ts`), todas com `notifications:manage`:
  - `retryNotificationAction({ id })`: zod uuid → `retryNotification` → `revalidatePath("/superadmin/notifications")`.
  - `sendTestNotificationAction({ channel, recipient })`: zod → `withUserTransaction(platformIdentity(identity), ...)` → `enqueueNotification` com `templateKey: "platform_test"`, `params: {}`, `idempotencyKey: "test:" + randomUUID()`. Superadmin em suporte recebe erro.
- `middleware.ts`: inclua `/api/internal/notifications/dispatch` e `/api/webhooks/whatsapp` em `publicPaths` (a rota se autentica sozinha).

**Testes (casos mínimos):**
- `enqueueNotification`: auditoria só na criação; duplicata sem auditoria; `audit metadata has no recipient or params`; rollback do chamador desfaz notificação e auditoria; `invalid_recipient` sem consulta ao banco; chave `cpf` recusada.
- `runDispatch` ponta a ponta com o driver fake do WhatsApp e `sendMail` mockado: `pending → sent`, `provider_message_id` gravado, payload apagado.
- `timeout reschedules with backoff`: o canal devolve transitório → `pending` com `next_attempt_at` futuro e evento `attempt_failed`.
- Erro permanente → `failed`; opt-out → `suppressed` sem chamar o canal; `budgetMs` curto para o laço.
- Rota: sem header, header errado e prefixo errado → 401; segredo ausente → 500; GET → 405; sucesso → 200 com contagens.
- Ações: `operator` e `bureau_admin` recebem erro; superadmin em suporte não envia teste; zod recusa id inválido e canal fora do enum.
- Middleware: as duas rotas novas passam sem cookie; `/api/internal/outra` continua bloqueada.
- Permissões: `notifications:manage` só no superadmin sem suporte.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/notifications/queries.integration.test.ts src/lib/notifications/dispatch.integration.test.ts src/app/api/internal src/actions/notifications.test.ts src/lib/db/permissions.test.ts src/middleware.test.ts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 4: Webhook da Meta — verificação, assinatura, status e opt-out

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/notifications/whatsapp-webhook.ts`, `src/lib/notifications/whatsapp-webhook.test.ts`
- Create: `src/app/api/webhooks/whatsapp/route.ts`, `src/app/api/webhooks/whatsapp/route.test.ts`

**Depends-on:** 1, 2 (o caminho público em `middleware.ts` vem da Task 3, na mesma onda; o teste chama o handler direto)

**Assinatura (forma exata):**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

// Meta assina o corpo bruto: calcule sobre os bytes recebidos, antes de qualquer JSON.parse.
export function signatureMatches(rawBody: Buffer, header: string | null, appSecret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

**Contrato:**
- `GET`: `hub.mode === "subscribe"`, `hub.verify_token` igual a `WHATSAPP_VERIFY_TOKEN` (comparação com hash e `timingSafeEqual`) e `hub.challenge` só com dígitos (até 64) → 200 com o desafio em `text/plain`. Qualquer outro caso → 403. Configuração ausente → 500.
- `POST`, nesta ordem:
  1. Configuração ausente → 500.
  2. Corpo lido com `request.arrayBuffer()`; mais de 262.144 bytes → 413.
  3. `signatureMatches` falso → 401.
  4. JSON inválido → 400.
  5. `parseWhatsappWebhook(raw)` (zod): `object === "whatsapp_business_account"`; para cada `entry[].changes[]` com `field === "messages"` e `value.metadata.phone_number_id` igual ao configurado, extrai `statuses[]` (`id`, `status` em `sent | delivered | read | failed`, `timestamp` em segundos, `errors[0].code`) e `messages[]` (`from`, `type`, `text.body`). Itens fora do formato são ignorados, não derrubam o lote.
  6. Para cada status: `apply_whatsapp_status` no pool `app_webhook`.
  7. **OptOutKeyword:** mensagem `text` cujo corpo, sem espaço nas pontas, em maiúsculas e sem acento, é `PARAR`, `SAIR`, `STOP`, `CANCELAR` ou `DESCADASTRAR` → `record_notification_opt_out("whatsapp", v)` para cada `v` de `brazilianVariants("+" + from)`.
  8. Erro de banco → 500 (a Meta reenvia). Sucesso, inclusive sem nada aplicável → 200.
- Log: só contagens (`applied`, `duplicate`, `orphan`, `ignored`, `optOut`) e nome/código do erro. Nunca o corpo, o `from`, o texto da mensagem nem o header de assinatura.

**Testes (casos mínimos):**
- `rejects missing, malformed and wrong X-Hub-Signature-256` (sem header, sem `sha256=`, hex curto, assinatura de outro segredo, corpo alterado em um byte) → 401, sem chamada ao banco.
- Assinatura correta sobre corpo com `á` escapado passa (prova o cálculo sobre bytes).
- GET: token certo devolve o desafio; token errado, modo errado e desafio com letra → 403.
- `duplicate status delivery changes nothing`: o mesmo POST duas vezes; a segunda conta `duplicate`.
- `phone_number_id` de outro número é ignorado.
- `opt-out matches wa_id without the ninth digit`: `from = "556392345615"` grava as duas formas.
- Palavra-chave dentro de frase (`"quero parar agora"`) não grava opt-out.
- Corpo acima do limite → 413; JSON quebrado com assinatura válida → 400.
- Erro do banco → 500; `never logs the body` (espione `console`).

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/notifications/whatsapp-webhook.test.ts src/app/api/webhooks/whatsapp` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 5: E-mail de autorização SCR pela fila

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Modify: `src/actions/scr-self.ts`, `src/actions/scr-self.test.ts`
- Modify: `src/lib/scr/queries.ts`; Create: `src/lib/scr/queries.integration.test.ts`
- Modify: `src/types/app.ts` (campo novo em `ScrAuthorization`)
- Delete: `src/lib/email/scr-authorization-email.ts`

**Depends-on:** 3

**Contrato:**
- `issueSelfScrAuthorization(identity, id, input)` ganha `input.notification: { recipient: string; clientName: string; authorizedName: string; siteUrl: string }`. Na mesma transação:
  1. O UPDATE atual devolve também `requested_at::text`.
  2. `enqueueNotification(client, identity, { templateKey: "scr_authorization", channel: "email", recipient, params: { clientName, authorizedName, code: input.code, url: `${siteUrl}/autorizacao-scr/${public_token}` }, idempotencyKey: `scr_authorization:${id}:${requested_at}`, reference: `scr_authorization:${id}` })`.
  3. **ScrIssueIsAtomic:** enfileiramento com `ok: false` lança erro tipado dentro da transação (rollback: o código antigo continua valendo). A função o captura fora da transação e devolve `{ ok: false, reason }`.
  - Retorno: `{ ok: true } | { ok: false, reason: "not_found" | "invalid_recipient" | "template_not_found" | ... }`.
- `sendScrSelfAuthorization`: remove `sendMail` e `buildScrAuthorizationEmail`; passa os dados acima; traduz `reason` em mensagem pt-BR (`invalid_recipient` → "Titular sem e-mail válido — cadastre o e-mail antes de enviar."; outros → "Não foi possível enfileirar o e-mail."). Mantém a regra de URL canônica (`config.betterAuthUrl`).
- `listScrAuthorizations` devolve `last_notification_status` (`pending | sending | sent | delivered | read | failed | suppressed | null`) por `left join lateral` em `notifications` com `reference = 'scr_authorization:' || s.id`, a mais recente. Acrescente o campo `lastNotificationStatus` em `ScrAuthorization`.
- Apague `scr-authorization-email.ts` e qualquer import dele. `mailer.ts` fica (a Task 2 o usa).

**Testes (casos mínimos):**
- Ação: o link usa a URL canônica, não `NEXT_PUBLIC_SITE_URL` (o teste atual muda para conferir `params.url` passado ao enfileiramento); e-mail inválido devolve a mensagem; falha do enfileiramento devolve erro.
- Integração: emitir enfileira uma notificação `scr_authorization` com `reference` certa e auditoria; emitir de novo cria outra notificação (outro `requested_at`); `template_not_found` (template retirado no teste) deixa o `auth_code` antigo intacto; operador do Bureau B não emite para o SCR do Bureau A.
- `listScrAuthorizations` traz o estado da notificação mais recente.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/actions/scr-self.test.ts src/lib/scr` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 6: Cron, segredos e operação

**Agent:** `devops-engineer` · `model: "sonnet"`
**Files:**
- Modify: `docker-stack.yml`, `Dockerfile`
- Create: `scripts/notifications-cron.mjs`, `scripts/notifications-cron.test.mjs`
- Modify: `package.json` (script `ops:test`), `.github/workflows/ci.yml` (passo `npm run ops:test`)
- Modify: `src/lib/runtime-secrets.mjs`, `src/lib/runtime-secrets.test.ts`
- Modify: `scripts/setup/setup_production.py`, `scripts/setup/test_setup_production.py`
- Modify: `.env.example`
- Create: `docs/operations/notifications.md`

**Depends-on:** none (rota e nomes de variável fixados neste plano)

**Contrato:**
- `scripts/notifications-cron.mjs`: lê `NOTIFICATIONS_DISPATCH_URL` e o segredo (`NOTIFICATIONS_DISPATCH_SECRET` ou `NOTIFICATIONS_DISPATCH_SECRET_FILE`); a cada 60 s faz `POST` com `Authorization: Bearer`, timeout de 55 s, e só começa a próxima chamada depois da anterior. Loga status HTTP e contagens; nunca o segredo. Sai com código 1 se a configuração faltar. Para com `SIGTERM`.
- `docker-stack.yml`:
  - `reino_app`: `WHATSAPP_DRIVER`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION` (env de deploy, não segredo) e os `_FILE` de `whatsapp_access_token`, `whatsapp_app_secret`, `whatsapp_verify_token` e `notifications_dispatch_secret`.
  - Serviço novo `notifications_cron`: `image: *app_image`, `entrypoint: ["node", "scripts/notifications-cron.mjs"]` (não roda as migrations do entrypoint do app), rede `private`, `NOTIFICATIONS_DISPATCH_URL=http://reino_app:3000/api/internal/notifications/dispatch`, segredo `notifications_dispatch_secret`, `read_only`, mesmo usuário, limites pequenos (`cpus: "0.1"`, `memory: 64M`), `restart_policy` igual ao do app.
- `Dockerfile`: copie `scripts/notifications-cron.mjs` para a imagem final.
- `runtime-secrets.mjs`: acrescente `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `NOTIFICATIONS_DISPATCH_SECRET` (e `ASAAS_*` já existentes ficam).
- `setup_production.py`: gera `notifications_dispatch_secret` e `whatsapp_verify_token` (`gen_hex(32)`); pergunta `whatsapp_access_token` e `whatsapp_app_secret` (aceita vazio = WhatsApp desligado); acrescenta `WHATSAPP_DRIVER`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION` em `ENV_KEYS`. Fecha o critério "Segredos no script de setup" da #35.
- `.env.example`: as variáveis novas com valores de exemplo de dev (`WHATSAPP_DRIVER=fake`, `NOTIFICATIONS_DISPATCH_SECRET=local-dispatch-secret-0123456789abcdef`, `NOTIFICATIONS_DISPATCH_URL=http://localhost:3000/api/internal/notifications/dispatch`); contagem de Docker secrets atualizada.
- `docs/operations/notifications.md`: como criar o app na Meta, o número e o token de sistema; onde cadastrar o webhook (`https://<APP_DOMAIN>/api/webhooks/whatsapp`, verify token, assinatura do campo `messages`); como aprovar um template e registrá-lo por migration (nome, idioma, ordem dos parâmetros); como rodar o worker em dev (`curl -X POST -H "Authorization: Bearer $NOTIFICATIONS_DISPATCH_SECRET" ...`); retentativa, estados, retenção de 7 dias, opt-out por palavra-chave e como removê-lo (SQL do dono); aviso de que template de marketing está fora.

**Testes (casos mínimos):**
- Script do cron (`node --test`): configuração ausente sai com 1; envia o header certo; não sobrepõe chamadas (servidor lento); não loga o segredo.
- `runtime-secrets`: as variáveis novas são lidas de `_FILE`.
- Setup: gera os dois segredos novos; aceita token vazio; `ENV_KEYS` tem as três chaves.
- `docker stack config -c docker-stack.yml` com env de exemplo passa (se o Docker estiver disponível; senão, declare no relatório).

- [ ] Escreva os testes (vermelhos), implemente, rode `npm run ops:test` (`node --test scripts/notifications-cron.test.mjs`; o Vitest só inclui `src/**/*.test.ts`), `npx vitest run src/lib/runtime-secrets.test.ts` e `npm run setup:test` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 7: Telas — log de notificações e selo na lista SCR

**Agent:** `frontend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/app/(superadmin)/superadmin/notifications/page.tsx`
- Create: `src/components/notifications/{NotificationLogTable,TemplateList,RetryNotificationButton,TestNotificationForm,NotificationStatusBadge}.tsx`
- Modify: `src/components/superadmin/superadmin-nav.tsx`
- Modify: `src/app/(dashboard)/scr/page.tsx`, `src/components/scr/scr-row-actions.tsx`

**Depends-on:** 3, 5

**Contrato:**
- Invoque `/ui-ux-pro-max` antes de escrever UI. Siga `src/components/CLAUDE.md`, `NfseFailuresTable.tsx` e as telas de `/superadmin/nfse`.
- `/superadmin/notifications` (`notifications:manage`): tabela do log (`listNotifications`) com data, Bureau, template, canal, destinatário mascarado, estado, tentativas e último código de erro; filtro por estado e canal; paginação por cursor (remonte a tabela com `key={rows[0]?.id ?? "empty"}`). "Tentar de novo" só em `failed`; motivo `payload_purged` vira "Dados do envio já apagados (mais de 7 dias)". Lista de templates ativos (`listTemplates`). Formulário "Enviar teste": canal e destinatário. Esconda os controles de gravação quando o superadmin está em suporte.
- `NotificationStatusBadge`: `pending`/`sending` → "Na fila", `sent` → "Enviado", `delivered`/`read` → "Entregue", `failed` → "Falhou", `suppressed` → "Bloqueado (opt-out)".
- Lista SCR: selo do último envio (`lastNotificationStatus`; nulo → sem selo). `scr-row-actions`: mensagem de sucesso "Autorização na fila de envio".
- `superadmin-nav`: item "Notificações".
- Textos em pt-BR. Estados de carregamento e erro visíveis; rótulos acessíveis.

**Testes:** UI de apresentação não leva teste. Teste só lógica com ramo extraída em função pura (mapa estado → selo; decisão de mostrar "Tentar de novo"). Verificação visual: `npm run dev` com `WHATSAPP_DRIVER=fake`, entre como superadmin e como operador. Se não for possível abrir o navegador, diga isso no relatório.

- [ ] Implemente, rode `npm run lint && npm run type-check` e os testes das funções extraídas.
- [ ] Verifique as telas no navegador, ou declare que não verificou.
- [ ] Entregue: lista de `Files changed`.

---

## Critérios de pronto

Cada critério aponta para o teste que o prova (lista da spec).

- Mesma chave de idempotência: sem segunda notificação nem segunda auditoria (Task 1, 3).
- Dois workers nunca pegam a mesma notificação (Task 1).
- Transitório reagenda com backoff; permanente e 8ª falha viram `failed` (Task 1, 3).
- Lease vencida volta para a fila; lease velha é ignorada (Task 1).
- Assinatura errada → 401; reenvio não muda nada; status não regride (Task 1, 4).
- Status antes do id é adotado (Task 1).
- Opt-out → `suppressed` sem chamar o provedor; nono dígito coberto (Task 1, 3, 4).
- Destinatário e parâmetros somem no estado final (Task 1).
- Bureau A não lê notificação do Bureau B; staff não lê destinatário nem parâmetros (Task 1).
- Telefone fora do E.164 é recusado (Task 2).
- E-mail SCR sai pela fila com o mesmo conteúdo; código intacto se o enfileiramento falhar (Task 5).
- Segredos do WhatsApp e do worker no script de setup e no stack (Task 6).
- `/superadmin/notifications` e o selo SCR funcionam (Task 7; verificação visual).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da onda 4.
- (post-deploy) A Meta aprova os templates usados e o webhook fica assinado no campo `messages`.
- (post-deploy) Um e-mail SCR real e um teste real de WhatsApp (`hello_world`) chegam, e `delivered` volta pelo webhook.
- (post-deploy) O `notifications_cron` roda a cada minuto e o log não mostra dados pessoais.

Cada item `(post-deploy)` vira um item "Post-deploy follow-up" no PR. Nenhum bloqueia o merge.

## Cobertura da spec

| Spec | Task |
|---|---|
| Decisão 1 (tabelas) | 1 |
| Decisão 2 (enfileiramento) | 1, 3 |
| Decisões 3–6 (worker, retentativa, entrega, estados) | 1, 2, 3 |
| Decisão 7 (webhook da Meta) | 1, 4 |
| Decisão 8 (opt-out) | 1, 3, 4 |
| Decisão 9 (dados pessoais) | 1, 3, 4 |
| Decisão 10 (telefone) | 2, 4 |
| Decisão 11 (e-mail SCR) | 1 (seed), 5, 7 |
| Decisões 12–13 (acesso, permissão) | 1, 3 |
| Telas | 7 |
| D3 (segredos só no ambiente) | 2, 6 |

## Ajustes nas issues (fora das tasks)

- #34: fechar com o PR; mover "Preferência de canal por destinatário" para uma issue nova do M5.
- #35: fechar com o PR (`Closes #35` no commit da Task 6).
- #36: manter aberta; o M4 entrega só o template SCR por e-mail.
