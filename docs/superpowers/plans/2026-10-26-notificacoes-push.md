# Notificações push e atalho no aparelho: Plano

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Use parallel waves (`.claude/rules/08-parallel-subagent-driven-development.md`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O cliente instala o portal na tela inicial, liga o push do aparelho em **Conta › Notificações** e recebe um aviso genérico em 4 eventos: sócio autorizou o SCR, consulta pronta, comissão recebida, comissão disponível para saque.

**Architecture:** Push é um terceiro canal da fila atual (`notifications`, `claim_notifications`, `complete_notification`, retentativa). Uma linha de `notifications` por inscrição de aparelho (`recipient` = id da inscrição). Os 4 eventos nascem em triggers SQL `AFTER` (SECURITY DEFINER, dono `auth_profile_lookup`) nas tabelas que já mudam no evento, na mesma transação, com chave de idempotência por evento e inscrição. As funções de negócio (`capture_order`, `release_due_commissions`, `confirm_public_scr_authorization`, `releaseDelivery`) não mudam. O worker busca endpoint e chaves por uma função só da `app_dispatch` que confere a lease e o dono da inscrição. Envio com `web-push` e VAPID. Service worker `public/sw.js` só com `push` e `notificationclick`.

**Tech Stack:** Next 14.2 App Router, React, TypeScript, `pg` sem ORM, PostgreSQL 18, zod, vitest, `web-push@3.6.7`.

**Spec:** `docs/superpowers/specs/2026-10-26-notificacoes-push-design.md`.

## Global Constraints

- Migration nova: `db/migrations/034_push_notifications.sql`. Não editar 001–033.
- Canal: `'push'`. CHECK de canal em `notification_templates.channel` e `notifications.channel` passa a `in ('email', 'whatsapp', 'push')`. `notification_opt_outs` e `profiles.notification_channel` não mudam.
- Templates push (versão 1, `params = array['url']`, sem corpo no banco): `scr_partner_authorized`, `research_released`, `commission_received`, `commission_available`.
- Texto do aviso (fixo no código, `src/lib/notifications/push-payload.ts`). Título: `BRAND_NAME`. Corpo:
  - `scr_partner_authorized`: "Um sócio autorizou sua consulta"
  - `research_released`: "Sua consulta está pronta"
  - `commission_received`: "Você recebeu uma comissão"
  - `commission_available`: "Você tem comissão disponível para saque"
- Payload do push: só `{ title, body, url }`. Nunca CPF, CNPJ, valor, nome do titular ou do sócio.
- `url` é caminho relativo: `/portal/pesquisas/<dossier_id>` (eventos 1 e 2; evento 1 sem pedido ligado: `/portal/pesquisas`), `/portal/afiliacao` (eventos 3 e 4).
- Chave de idempotência (`notifications.idempotency_key`, sempre com `:<subscription_id>` no fim):
  - Evento 1: `scr_partner_authorized:<scr_authorization_id>`
  - Evento 2: `research_released:push:<dossier_id>:<released_at em ms>`
  - Evento 3: `commission_received:<commission_id>`
  - Evento 4: `commission_available:<affiliate_profile_id>:<pg_current_xact_id()>` (uma execução de `release_due_commissions` = uma transação).
- Linha push: `recipient` = `push_subscriptions.id::text`, `recipient_masked` = `'aparelho ' || left(id::text, 8)`, `created_by` = perfil destinatário, `bureau_id` = Bureau da linha que disparou.
- Destinatário: só perfil `role = 'client'`, `is_active`, `anonymized_at is null`, com inscrição. Sem inscrição: nenhuma linha.
- Máximo de 10 inscrições por perfil. A 11ª remove a mais antiga (`updated_at`).
- Hosts de push aceitos (https, porta padrão, sem userinfo): `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, sufixo `.notify.windows.com`. Endpoint até 2048 caracteres.
- Chaves: `p256dh` `^[A-Za-z0-9_-]{80,100}$`, `auth` `^[A-Za-z0-9_-]{16,32}$`. `user_agent` até 512.
- Env (servidor, nunca `NEXT_PUBLIC_`): `WEB_PUSH_VAPID_PUBLIC_KEY` (base64url, 87), `WEB_PUSH_VAPID_PRIVATE_KEY` (base64url, 43), `WEB_PUSH_VAPID_SUBJECT` (`mailto:` ou `https://`). Os três vazios = canal desligado. Gerar: `npx web-push generate-vapid-keys`.
- Envio: `TTL` 86400 s, `urgency: "normal"`, `timeout` 10000 ms. `providerMessageId` = `push:<notification.id>`.
- Códigos de erro: `push_gone` (404/410, permanente, inscrição removida), `subscription_gone` (inscrição não existe ou mudou de dono, permanente), `invalid_endpoint` (permanente), `channel_not_configured` (permanente), `config_error`, `rate_limited`, `provider_unavailable`, `provider_timeout`, `network_error` (transitórios), `provider_rejected` (permanente).
- Auditoria (no SQL, mesma transação): `client.push_subscribed`, `client.push_unsubscribed`, `table_name = 'profiles'`, `record_id = user_id`, metadata sem endpoint.
- Tela: `/portal/notificacoes`, item "Notificações" em `AccountMenu`. iPhone: botão de ligar só com app instalado e iOS 16.4 ou mais novo.
- Logs: nunca endpoint, chaves, `params` ou mensagem do `WebPushError` (ela leva o endpoint). Só id, canal e código.
- Dependência: o coordenador roda `npm install web-push@3.6.7` e `npm install -D @types/web-push@3.6.4` antes da Wave 2 (dono do lockfile). Nenhum implementador edita `package.json` ou `package-lock.json`.
- Implementadores não commitam. Gate da tarefa: testes da tarefa verdes. O coordenador faz um commit por tarefa, em ordem.
- Rodar `graphify update .` depois de cada wave.

## Decisões do construtor (spec, "O que fica para quem constrói")

1. **Gatilhos por trigger, não por cópia das funções.** `capture_order` (145 linhas), `release_due_commissions` e `confirm_public_scr_authorization` ficam como estão. Triggers `AFTER` em `scr_authorizations`, `dossier_orders` e `affiliate_commissions` chamam o auxiliar `enqueue_push_for_profile`. Motivo: diff menor e sem risco de divergir de uma cópia de função de dinheiro.
2. **Evento 2 também por trigger** (`dossier_orders` vai a `released` com `released_at` novo). `enqueueReleaseNotices` (TS) não muda: e-mail e WhatsApp seguem iguais.
3. **`apply_asaas_payment` não muda.** Ela só reverte comissão; a comissão nasce só em `capture_order` (insert em `affiliate_commissions`).
4. **Uma linha por inscrição.** A retentativa de um aparelho não reenvia para os outros. O worker só lê endpoint e chaves com a lease válida e com `push_subscriptions.profile_id = notifications.created_by`. Inscrição transferida (upsert por endpoint) ou removida: aviso antigo vira `subscription_gone`. O perfil anterior nunca chega ao aparelho do outro.
5. **`claim_notifications` não muda.** Linhas push voltam com campos de template nulos e `opted_out = false`. O texto vem do código; o banco guarda só a chave e `params`.
6. **Evento 1 sem push quando o sócio é o próprio comprador** (`lower(scr_authorizations.email) = lower(profiles.email)` do comprador). Ele mesmo acabou de autorizar; o aviso seria ruído. Spec diz "cada sócio": o cliente pode mudar isso.
7. **Logout:** o botão Sair do portal e o `IdleTimeout` cancelam a inscrição no navegador (`subscription.unsubscribe()`) e mandam o endpoint em `pushEndpoint` para `signOut(formData)`, que remove a linha antes de encerrar a sessão. Falha na remoção não impede o logout. Mesmo sem a remoção, o endpoint cancelado devolve 410 e o worker remove a linha.
8. **Sem sincronização automática.** A tela mostra "ligado" só quando o navegador tem inscrição e o servidor confirma que ela é do perfil atual (`push_subscription_active`). Outro perfil no mesmo aparelho só recebe push depois de ligar o botão.
9. **Conta encerrada:** trigger em `profiles` remove as inscrições quando `is_active` fica falso ou `anonymized_at` é preenchido (LGPD: endpoint é dado do aparelho).
10. **Endpoint:** allowlist de hosts no TS (zod na ação e nova checagem no canal, contra SSRF). O SQL confere só `https://` e tamanho.

## Review Focus

1. Aviso de um perfil chega ao aparelho de outro perfil após transferência de endpoint ou logout. Teste: Task 1, "delivery lookup returns no row after endpoint transfer".
2. Aviso duplicado quando o gatilho roda de novo (link aberto de novo, mesma execução de liberação, captura repetida). Testes: Task 1, "event 1 … confirm twice", "event 4 one notice per affiliate per run", "event 3 capture twice".
3. SSRF: worker faz POST para endpoint de host qualquer. Testes: Task 3, `push-endpoint.test.ts` (host falso, userinfo, IP, porta); Task 4, "endpoint not allowlisted is not sent".
4. Dado sensível na tela bloqueada. Teste: Task 4, `push-payload.test.ts` "output has only title, body and url" e "absolute url is rejected".
5. Grant ou RLS deixa `app_runtime`, `app_webhook` ou outro cliente ler endpoint e chaves ou remover inscrição alheia. Testes: Task 1, bloco `push_subscriptions` em `rls.integration.test.ts` e "remove other client's endpoint removes nothing".

## Waves

| Wave | Tarefas | Motivo |
|---|---|---|
| 1 | Task 1, Task 2 | Sem dependência; arquivos disjuntos. |
| — | Coordenador: `npm install web-push@3.6.7`, `npm install -D @types/web-push@3.6.4` | Lockfile do coordenador. |
| 2 | Task 3 | Usa as funções SQL da Task 1. |
| 3 | Task 4, Task 5 | Task 4 usa Task 1 e Task 3; Task 5 usa Task 2 e Task 3; arquivos disjuntos. |

---

### Task 1: Migration 034 (canal push, inscrições, gatilhos) e testes de banco

**Specialist:** `database-architect` (model `sonnet`). Skill: `/postgresql-database-engineering`.
**Files:** Create `db/migrations/034_push_notifications.sql`, `src/lib/notifications/push.integration.test.ts`. Modify `src/lib/db/rls.integration.test.ts` (novo bloco `describe("push_subscriptions")`), `db/migrations/CLAUDE.md` (linha da 034; "next number is 035").
**Depends-on:** none
**Rules:** `db/migrations/CLAUDE.md` (forward-only, sem `begin`/`commit`, definer com `search_path`, `revoke ... from public`), `06-security` (RLS forçada, grant mínimo), `05-testing`, AGENTS "Patterns" (auditoria na mesma transação).

**Interfaces (produces):**

```sql
-- Funções para app_runtime (SECURITY DEFINER, dono auth_profile_lookup)
register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
  returns table (ok boolean, reason text)          -- reason: not_allowed | invalid_input
remove_push_subscription(p_endpoint text)
  returns table (ok boolean, reason text)          -- reason: not_allowed. Endpoint alheio ou ausente: ok = true, nada muda
push_subscription_active(p_endpoint text) returns boolean   -- true só se o endpoint é do perfil da sessão

-- Funções para app_dispatch (SECURITY DEFINER, dono auth_profile_lookup)
push_subscription_for_delivery(p_notification_id uuid, p_lease_id uuid)
  returns table (endpoint text, p256dh text, auth text)     -- 0 ou 1 linha
delete_gone_push_subscription(p_notification_id uuid, p_lease_id uuid) returns boolean

-- Interna, sem grant (dono auth_profile_lookup, não definer; só os triggers chamam)
enqueue_push_for_profile(p_profile_id uuid, p_template_key text, p_url text, p_event_key text, p_reference text)
  returns integer                                           -- linhas novas
```

**Contrato SQL (forma exata é requisito):**

```sql
-- 1) Canal. Confirmar os nomes reais com: select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid in ('notifications'::regclass, 'notification_templates'::regclass);
alter table notification_templates drop constraint notification_templates_channel_check;
alter table notification_templates add constraint notification_templates_channel_check
  check (channel in ('email', 'whatsapp', 'push'));
alter table notification_templates drop constraint notification_templates_check;   -- CHECK de conteúdo da 020
alter table notification_templates add constraint notification_templates_content_check check (
  (channel = 'email' and email_subject is not null and email_html is not null and email_text is not null
    and wa_template_name is null and wa_language is null)
  or (channel = 'whatsapp' and wa_template_name is not null and wa_language is not null
    and email_subject is null and email_html is null and email_text is null)
  or (channel = 'push' and email_subject is null and email_html is null and email_text is null
    and wa_template_name is null and wa_language is null));
alter table notifications drop constraint notifications_channel_check;
alter table notifications add constraint notifications_channel_check check (channel in ('email', 'whatsapp', 'push'));
alter table notifications add constraint notifications_push_recipient_check check (
  recipient is null or channel <> 'push'
  or recipient ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

insert into notification_templates (key, channel, version, params) values
  ('scr_partner_authorized', 'push', 1, array['url']),
  ('research_released', 'push', 1, array['url']),
  ('commission_received', 'push', 1, array['url']),
  ('commission_available', 'push', 1, array['url']);

-- 2) Inscrições
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  bureau_id uuid not null,
  profile_id uuid not null,
  endpoint text not null unique check (endpoint ~ '^https://\S+$' and length(endpoint) <= 2048),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  user_agent text check (user_agent is null or length(user_agent) <= 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (bureau_id, profile_id) references profiles (bureau_id, id) on delete cascade
);
create index push_subscriptions_profile_idx on push_subscriptions (profile_id, updated_at desc);

-- 3) Auxiliar: uma linha por inscrição ativa; idempotente por (bureau_id, idempotency_key).
--    Corpo: lê o template ativo (key, 'push'); sem template: raise (erro de deploy, desfaz a transação).
insert into public.notifications
  (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params,
   idempotency_key, reference, created_by)
select s.bureau_id, v_tpl.id, 'push', s.id::text, 'aparelho ' || left(s.id::text, 8),
       public.notification_recipient_hash(s.id::text), jsonb_build_object('url', p_url),
       p_event_key || ':' || s.id::text, p_reference, s.profile_id
  from public.push_subscriptions s
  join public.profiles p on p.id = s.profile_id
 where s.profile_id = p_profile_id and p.role = 'client' and p.is_active and p.anonymized_at is null
on conflict (bureau_id, idempotency_key) do nothing
returning id, bureau_id;   -- para cada linha nova: notification_events (kind 'queued')

-- 4) Busca do worker: lease válida e dono igual ao destinatário original.
select s.endpoint, s.p256dh, s.auth
  from public.notifications n
  join public.push_subscriptions s on s.id::text = n.recipient and s.profile_id = n.created_by
 where n.id = p_notification_id and n.lease_id = p_lease_id and n.status = 'sending' and n.channel = 'push';
-- delete_gone_push_subscription: delete ... using notifications n com as mesmas condições; return found.

-- 5) Triggers (funções SECURITY DEFINER, dono auth_profile_lookup, revoke all from public)
create trigger scr_authorizations_push after update of status on scr_authorizations for each row
  when (new.status = 'authorized' and old.status is distinct from new.status
        and new.client_profile_id is not null and new.channel = 'internal')
  execute function push_on_scr_authorized();
  -- Sem push se lower(new.email) = lower(email do comprador). dossier = consultations.dossier_id mais novo com
  -- scr_authorization_id = new.id. reference = 'order:' || dossier (ou 'scr:' || new.id sem pedido).
create trigger dossier_orders_push after update of state, released_at on dossier_orders for each row
  when (new.state = 'released' and new.client_profile_id is not null
        and new.released_at is distinct from old.released_at)
  execute function push_on_order_released();          -- reference 'order:' || dossier_id
create trigger affiliate_commissions_push_created after insert on affiliate_commissions for each row
  execute function push_on_commission_created();      -- reference 'commission:' || id
create trigger affiliate_commissions_push_released after update of status on affiliate_commissions for each row
  when (old.status = 'pending' and new.status = 'released')
  execute function push_on_commission_released();     -- reference 'affiliate:' || affiliate_profile_id
create trigger profiles_drop_push_subscriptions after update of is_active, anonymized_at on profiles for each row
  when (new.anonymized_at is not null or not new.is_active)
  execute function push_drop_on_profile_closed();     -- delete from push_subscriptions where profile_id = new.id

-- 6) Acesso
alter table push_subscriptions owner to schema_owner;
alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
revoke all on push_subscriptions from public, app_runtime, app_webhook, app_dispatch, auth_profile_lookup;
grant select on push_subscriptions to backup_reader;
grant select, insert, delete, update (bureau_id, profile_id, p256dh, auth, user_agent, updated_at)
  on push_subscriptions to auth_profile_lookup;
create policy push_subscriptions_gateway_select on push_subscriptions for select to auth_profile_lookup using (true);
create policy push_subscriptions_gateway_insert on push_subscriptions for insert to auth_profile_lookup with check (true);
create policy push_subscriptions_gateway_update on push_subscriptions for update to auth_profile_lookup
  using (true) with check (true);
create policy push_subscriptions_gateway_delete on push_subscriptions for delete to auth_profile_lookup using (true);
create policy audit_logs_client_push_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('client.push_subscribed', 'client.push_unsubscribed')
  and table_name = 'profiles' and record_id = user_id and support_session_id is null
  and exists (select 1 from profiles p
               where p.id = audit_logs.user_id and p.role = 'client' and p.bureau_id = audit_logs.bureau_id));
grant execute on function register_push_subscription(text, text, text, text), remove_push_subscription(text),
  push_subscription_active(text) to app_runtime;
grant execute on function push_subscription_for_delivery(uuid, uuid), delete_gone_push_subscription(uuid, uuid)
  to app_dispatch;
```

Regras de `register_push_subscription`: contexto presente, `app_user_role() = 'client'`, perfil `app_user_id()` ativo, não anonimizado, do `app_bureau_id()`; senão `not_allowed`. Formato fora das regras de Global Constraints: `invalid_input`. Linha existente do mesmo perfil: atualiza chaves, `user_agent`, `updated_at`; sem auditoria. Linha nova ou de outro perfil: upsert `on conflict (endpoint)` para o perfil da sessão e auditoria `client.push_subscribed`. Depois, apaga as inscrições do perfil além das 10 mais novas.

Grants em outras tabelas: o dono dos triggers precisa ler `profiles (id, role, bureau_id, is_active, anonymized_at, email)`, `scr_authorizations (id, email, client_profile_id, channel, status)`, `consultations (dossier_id, scr_authorization_id, created_at)`, `dossier_orders`, `affiliate_commissions`. Conferir com `has_column_privilege('auth_profile_lookup', ...)` e com as políticas `*_gateway_*` existentes; adicionar só o que falta (grant de coluna + política `to auth_profile_lookup`).

**Test cases** (`push.integration.test.ts`, Postgres real; reusar seeds de `notifications.integration.test.ts` e `src/lib/affiliates/commission.integration.test.ts`):
- [ ] "register creates one row and audits": cliente A registra → 1 linha, 1 `audit_logs` `client.push_subscribed` sem endpoint no metadata.
- [ ] "register same endpoint same profile updates keys without audit": 2ª chamada → 1 linha, chaves novas, auditoria continua 1.
- [ ] "register same endpoint by another client transfers it": cliente B registra o endpoint de A → `profile_id = B`, auditoria de B.
- [ ] "register rejects staff and bad input": operador → `not_allowed`; `http://...`, `p256dh` curto, `auth` com `=` → `invalid_input`.
- [ ] "eleventh subscription evicts the oldest": 11 registros → 10 linhas, a mais antiga saiu.
- [ ] "remove own endpoint deletes and audits"; "remove other client's endpoint removes nothing": `ok = true`, linha de A fica, sem auditoria.
- [ ] "push_subscription_active": próprio → true; de outro → false; ausente → false.
- [ ] "event 1 one notice per subscription; confirm twice keeps count": comprador com 2 inscrições, `confirm_public_scr_authorization(..., 'authorize')` → 2 linhas `scr_partner_authorized`, `params = {"url": "/portal/pesquisas/<dossier>"}`; 2ª confirmação → `already`, ainda 2.
- [ ] "event 1 skipped for self member, refusal and buyer without subscription": cada caso → 0 linhas.
- [ ] "event 2 adds push and keeps e-mail": `releaseDelivery` → linha e-mail `research_released` (como hoje) + 1 linha push por inscrição; revogar e liberar de novo → novo conjunto (novo `released_at`).
- [ ] "event 3 one notice per commission": captura que gera comissão para afiliado com inscrição → 1 linha `commission_received`, url `/portal/afiliacao`; `capture_order` de novo no mesmo pedido → `captured`, ainda 1. Afiliado sem inscrição → 0.
- [ ] "event 4 one notice per affiliate per run": 2 comissões vencidas do mesmo afiliado, 1 chamada de `release_due_commissions()` → 1 linha `commission_available` por inscrição; nova comissão vencida e nova chamada → +1; chamada sem nada vencido → +0.
- [ ] "delivery lookup returns endpoint only with the lease": como `app_dispatch`, após `claim_notifications` → 1 linha; lease errada → 0.
- [ ] "delivery lookup returns no row after endpoint transfer": aviso pendente de A, B registra o mesmo endpoint, claim → `push_subscription_for_delivery` → 0 linhas.
- [ ] "delete_gone removes the subscription only with the lease": lease válida → true e linha some; lease errada → false.
- [ ] "closed account drops subscriptions": `is_active = false` → 0 inscrições; anonimização (`lgpd_anonymize_client_account`) → 0.
- [ ] "push template with e-mail body is rejected" e "push row with non-uuid recipient is rejected": `check_violation`.

**Test cases** (`rls.integration.test.ts`, bloco `push_subscriptions`):
- [ ] `app_runtime` com contexto de cliente: `select`, `insert`, `update`, `delete` em `push_subscriptions` → permission denied.
- [ ] `app_webhook` e `app_dispatch`: `select` em `push_subscriptions` → permission denied.
- [ ] `app_runtime` não executa `push_subscription_for_delivery`, `delete_gone_push_subscription`, `enqueue_push_for_profile`; `app_dispatch` não executa `register_push_subscription`.

- [ ] Rodar: `npm run db:migrate` (banco de teste) e `npx vitest run src/lib/notifications/push.integration.test.ts src/lib/db/rls.integration.test.ts src/lib/notifications/notifications.integration.test.ts src/lib/affiliates/commission.integration.test.ts`.
- [ ] Commit (coordenador): `feat(db): canal push, inscrições de aparelho e gatilhos dos avisos`.

### Task 2: Base do app instalável (service worker, iPhone, detecção)

**Specialist:** `frontend-specialist` (model `sonnet`). Skill: `/vercel:nextjs`.
**Files:** Create `public/sw.js`, `src/lib/pwa/push-support.ts`, `src/lib/pwa/push-support.test.ts`, `src/lib/pwa/service-worker.ts`. Modify `src/app/layout.tsx`, `src/middleware.ts`, `src/middleware.test.ts`, `next.config.mjs`.
**Depends-on:** none
**Rules:** `next/coding-standards`, `typescript/coding-standards`, `06-security` (abrir só caminho do mesmo site), `05-testing` (frontend: só lógica).

**Interfaces (produces):**

```ts
// src/lib/pwa/push-support.ts (puro)
export type PushSupport = "ready" | "ios_install_required" | "ios_too_old" | "unsupported";
export interface BrowserTraits {
	userAgent: string;
	maxTouchPoints: number;
	standalone: boolean; // matchMedia('(display-mode: standalone)') ou navigator.standalone
	hasServiceWorker: boolean;
	hasPushManager: boolean;
	hasNotification: boolean;
}
export function isIos(userAgent: string, maxTouchPoints: number): boolean; // iPhone/iPad/iPod ou Macintosh com toque
export function iosVersion(userAgent: string): { major: number; minor: number } | null;
export function pushSupport(traits: BrowserTraits): PushSupport;
export function readBrowserTraits(): BrowserTraits; // só no cliente

// src/lib/pwa/service-worker.ts ("use client"; cola de navegador, sem teste)
export function registerPushServiceWorker(): Promise<ServiceWorkerRegistration>; // "/sw.js", scope "/"
export function currentPushSubscription(): Promise<PushSubscription | null>;
// Para o logout: cancela a inscrição no navegador e devolve o endpoint (ou null). Nunca lança.
export function releaseDevicePushForLogout(): Promise<string | null>;
```

Regras:
- `pushSupport`: iOS → versão < 16.4 → `ios_too_old`; não `standalone` → `ios_install_required`; senão segue as checagens gerais. Sem `serviceWorker`, `PushManager` ou `Notification` → `unsupported`. Senão `ready`.
- `public/sw.js`: só `push` e `notificationclick`, sem `fetch` (sem cache offline). `push`: lê JSON com try/catch; `showNotification(title, { body, icon: "/brand/rainha-cred/icones/icone-fundo-branco-192.png", data: { url } })`. `notificationclick`: fecha; `url` só se começa com `/` e não com `//`, senão `/portal`; foca janela do mesmo site e navega, ou `clients.openWindow`.
- `layout.tsx` (`metadata`): `appleWebApp: { capable: true, title: BRAND_NAME, statusBarStyle: "default" }`, `icons: { apple: "/brand/rainha-cred/icones/icone-fundo-branco-180.png" }` (o arquivo existe).
- `middleware.ts`: `"/sw.js"` em `publicPaths`.
- `next.config.mjs`: bloco de headers para `source: "/sw.js"` com `Cache-Control: no-cache` e `Content-Type: application/javascript; charset=utf-8`. CSP atual fica (`worker-src 'self' blob:` já cobre).

**Test cases:**
- [ ] `push-support.test.ts`: iPhone iOS 17.2 Safari, não standalone → `ios_install_required`; o mesmo standalone com PushManager → `ready`; iOS 16.3 standalone → `ios_too_old`; iOS 16.4 standalone → `ready`; iPadOS com UA "Macintosh" e `maxTouchPoints` 5 não standalone → `ios_install_required`; Mac Safari (`maxTouchPoints` 0) → `ready`; Android Chrome → `ready`; Chrome no iPhone (`CriOS`) não standalone → `ios_install_required`; sem `serviceWorker` → `unsupported`.
- [ ] `middleware.test.ts`: `/sw.js` passa sem cookie.
- [ ] Rodar: `npx vitest run src/lib/pwa/push-support.test.ts src/middleware.test.ts` e `npm run type-check`.
- [ ] Commit (coordenador): `feat(pwa): service worker de push, metadados do iPhone e detecção de suporte`.

### Task 3: Inscrição do aparelho (VAPID, regras do endpoint, ações e logout)

**Specialist:** `backend-specialist` (model `sonnet`).
**Files:** Create `src/lib/notifications/push-endpoint.ts`, `src/lib/notifications/push-endpoint.test.ts`, `src/lib/notifications/push-subscriptions.ts`, `src/lib/validators/push.ts`, `src/lib/validators/push.test.ts`, `src/actions/auth.test.ts`. Modify `src/lib/config.ts`, `src/lib/config.test.ts`, `src/actions/account.ts`, `src/actions/account.test.ts`, `src/actions/auth.ts`, `.env.example`, `docs/setup.md`.
**Depends-on:** Task 1
**Rules:** AGENTS "Server Actions" (zod `safeParse` → sessão + `hasPermission(role, "portal:write")` → query → `revalidatePath`; retorno `{ error }`), AGENTS "Data access" (`withUserTransaction`, `PoolClient` não sai do módulo), `06-security` (allowlist, sem log de endpoint), `05-testing`.

**Interfaces (consumes):** funções SQL da Task 1 (`register_push_subscription`, `remove_push_subscription`, `push_subscription_active`).

**Interfaces (produces):**

```ts
// src/lib/config.ts
export interface PushConfig { publicKey: string; privateKey: string; subject: string }
export function readPushConfig(env: Environment): PushConfig | null; // 3 vazios → null; parcial ou inválido → throw

// src/lib/notifications/push-endpoint.ts
export const PUSH_SERVICE_HOSTS: readonly string[]; // exatos + sufixo ".notify.windows.com"
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;
export function isAllowedPushEndpoint(value: string): boolean;

// src/lib/validators/push.ts
export const pushEndpointSchema: z.ZodType<string>;
export const pushSubscriptionSchema: z.ZodObject<{ endpoint; keys: z.ZodObject<{ p256dh; auth }> }>; // formato de PushSubscription.toJSON()

// src/lib/notifications/push-subscriptions.ts
export type PushSubscriptionReason = "not_allowed" | "invalid_input";
export function registerPushSubscription(
	client: PoolClient,
	input: { endpoint: string; p256dh: string; auth: string; userAgent: string | null },
): Promise<{ ok: true } | { ok: false; reason: PushSubscriptionReason }>;
export function removePushSubscription(client: PoolClient, endpoint: string): Promise<{ ok: true } | { ok: false; reason: "not_allowed" }>;
export function isPushSubscriptionActive(client: PoolClient, endpoint: string): Promise<boolean>;

// src/actions/account.ts (reusar runAsClient / requireClient)
export async function registerPushSubscriptionAction(values: unknown): Promise<ActionResult>;
export async function removePushSubscriptionAction(values: unknown): Promise<ActionResult>; // values: { endpoint }
export async function getPushSubscriptionStatusAction(values: unknown): Promise<{ error: string | null; subscribed: boolean }>;

// src/actions/auth.ts
export async function signOut(formData?: FormData): Promise<void>; // campo opcional "pushEndpoint"
```

Regras:
- `isAllowedPushEndpoint`: `new URL` válido, `protocol === "https:"`, `username`/`password` vazios, `port === ""`, host exato da lista ou terminado em `.notify.windows.com`, tamanho ≤ 2048.
- Ações de push: `revalidatePath("/portal/notificacoes")` no sucesso. `userAgent` vem de `requestMeta(headers())`. Mensagens pt-BR do `MESSAGES` atual (`not_allowed`, `invalid_input` → "Ação não permitida.").
- `signOut(formData)`: se `pushEndpoint` passa em `pushEndpointSchema` e a sessão é `client`, chama `removePushSubscription` em `withUserTransaction` antes de `auth.api.signOut`. Erro na remoção: `console.warn("[auth] remoção do aparelho falhou", { name })` e o logout segue. Os `<form action={signOut}>` e a chamada sem argumento do `IdleTimeout` continuam válidos.
- `.env.example`: as 3 variáveis vazias com comentário (gerar com `npx web-push generate-vapid-keys`; vazias = push desligado). `docs/setup.md`: as 3 variáveis no ponto onde o setup lista env de deploy.

**Test cases:**
- [ ] `config.test.ts` `readPushConfig`: 3 vazias → `null`; só a pública → throw; pública com 86 caracteres → throw; privada com `+` → throw; `subject` `mailto:contato@rainhadocredito.com` → ok; `http://x` → throw.
- [ ] `push-endpoint.test.ts`: aceita `https://fcm.googleapis.com/fcm/send/abc`, `https://updates.push.services.mozilla.com/wpush/v2/x`, `https://web.push.apple.com/QH...`, `https://wns2-bn3p.notify.windows.com/w/?token=x`; recusa `http://fcm.googleapis.com/x`, `https://fcm.googleapis.com.evil.com/x`, `https://evil.com/fcm.googleapis.com`, `https://fcm.googleapis.com@evil.com/x`, `https://fcm.googleapis.com:8443/x`, `https://127.0.0.1/x`, `https://notify.windows.com.evil/x`, texto com 2049 caracteres, texto inválido.
- [ ] `push.test.ts` (validators): JSON válido passa; host fora da lista, `p256dh` curto, `auth` longo, sem `keys` → falha com mensagem pt-BR; campo extra (`expirationTime`) é descartado.
- [ ] `account.test.ts`: `registerPushSubscriptionAction` com entrada inválida → `{ error }` e nenhuma query; sessão operador → "Ação não permitida."; ok → `{ error: null }` e `revalidatePath("/portal/notificacoes")`; reason `not_allowed` do SQL → "Ação não permitida.". `removePushSubscriptionAction`: mesmos ramos. `getPushSubscriptionStatusAction`: endpoint inválido → `subscribed: false` sem query; ok → valor do SQL.
- [ ] `auth.test.ts`: com `pushEndpoint` válido e sessão cliente → remoção antes de `auth.api.signOut`, depois `redirect("/login")`; remoção lança → logout segue; sem FormData → sem remoção; endpoint inválido → sem remoção; sessão de equipe → sem remoção.
- [ ] Rodar: `npx vitest run src/lib/config.test.ts src/lib/notifications/push-endpoint.test.ts src/lib/validators/push.test.ts src/actions/account.test.ts src/actions/auth.test.ts` e `npm run type-check`.
- [ ] Commit (coordenador): `feat(push): inscrição do aparelho, chaves VAPID e remoção no logout`.

### Task 4: Canal push no worker

**Specialist:** `backend-specialist` (model `sonnet`).
**Files:** Create `src/lib/notifications/channels/push.ts`, `src/lib/notifications/channels/push.test.ts`, `src/lib/notifications/push-payload.ts`, `src/lib/notifications/push-payload.test.ts`. Modify `src/lib/notifications/types.ts`, `src/lib/notifications/queries.ts` (só tipos de leitura), `src/lib/notifications/dispatch.ts`, `src/lib/notifications/dispatch.test.ts`, `src/lib/notifications/dispatch.integration.test.ts`, `src/lib/notifications/errors.ts`, `src/lib/notifications/errors.test.ts`, `src/components/notifications/notification-logic.ts`, `src/app/(superadmin)/superadmin/notifications/page.tsx`, `docs/operations/notifications.md`, `docs/architecture.md` (linha de `lib/notifications/`: canais email, whatsapp, push).
**Depends-on:** Task 1, Task 3
**Rules:** cabeçalho de `dispatch.ts` (nenhum destinatário, parâmetro ou mensagem de provedor no log), `06-security`, `02-design-patterns` (Adapter só para `web-push`), `05-testing`.

**Interfaces (consumes):** `push_subscription_for_delivery`, `delete_gone_push_subscription` (Task 1); `readPushConfig`, `isAllowedPushEndpoint` (Task 3); `web-push` (`sendNotification`, `WebPushError.statusCode`).

**Interfaces (produces):**

```ts
// types.ts — NotificationChannel (preferência do perfil e enqueueNotification) não muda.
export type DeliveryChannel = NotificationChannel | "push";
// ClaimedNotification.channel, NotificationRow.channel, ListNotificationsInput.channel, TemplateRow.channel: DeliveryChannel

// push-payload.ts
export type PushTemplateKey = "scr_partner_authorized" | "research_released" | "commission_received" | "commission_available";
export interface PushPayload { title: string; body: string; url: string }
export function buildPushPayload(templateKey: string, params: Record<string, string>): PushPayload; // TemplateRenderError

// errors.ts
export function classifyPushError(error: unknown): ErrorClassification;

// channels/push.ts
export interface PushDeps {
	send: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: object) => Promise<unknown>;
	query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>; // padrão: getDispatchPool().query
}
export async function sendPushNotification(notification: ClaimedNotification, deps?: Partial<PushDeps>): Promise<SendResult>;
```

Fluxo de `sendPushNotification` (ordem é requisito):
1. `readPushConfig(process.env)`: throw → `{ permanent: false, code: "config_error" }`; `null` → `{ permanent: true, code: "channel_not_configured" }`.
2. `buildPushPayload(template_key, params)`: `TemplateRenderError` → permanente com o código dele.
3. `select endpoint, p256dh, auth from push_subscription_for_delivery($1, $2)` com `[id, lease_id]`. 0 linhas → `{ permanent: true, code: "subscription_gone" }`.
4. `isAllowedPushEndpoint(endpoint)` falso → `{ permanent: true, code: "invalid_endpoint" }`, sem envio.
5. `send(subscription, JSON.stringify(payload), { vapidDetails, TTL: 86400, urgency: "normal", timeout: 10000 })`. Ok → `{ ok: true, providerMessageId: "push:<id>" }`.
6. Erro → `classifyPushError`. Código `push_gone` → `select delete_gone_push_subscription($1, $2)` antes de devolver o resultado.

`classifyPushError`: `statusCode` 404/410 → `push_gone` permanente; 429 → `rate_limited`; ≥ 500 → `provider_unavailable`; 401/403 → `config_error` (transitório); outro 4xx → `provider_rejected` permanente; sem `statusCode`: `name` `TimeoutError`/`AbortError` ou `code` `ETIMEDOUT` → `provider_timeout`; resto → `network_error`.

`buildPushPayload`: chave fora de `PushTemplateKey` → `TemplateRenderError`; `params.url` ausente, sem `/` inicial ou com `//` inicial → `TemplateRenderError`. Saída só com `title`, `body`, `url`.

`dispatch.ts`: `send()` escolhe por canal (`email`, `whatsapp`, `push`) num `switch`. Resto do fluxo igual. `CHANNEL_LABEL` ganha `push: "Push"`; filtro de canal da página do superadmin aceita `push`. `src/lib/validators/notifications.ts` (envio de teste) não muda.

`docs/operations/notifications.md`: título "(e-mail, WhatsApp e push)"; seção nova "Push no aparelho": gerar VAPID, as 3 variáveis, desligado quando vazias, iPhone só com app instalado (iOS 16.4+), códigos `push_gone`/`subscription_gone`, inscrição removida em 404/410 e no logout, e a verificação pós-deploy.

**Test cases:**
- [ ] `push-payload.test.ts`: cada uma das 4 chaves → `title = BRAND_NAME` e corpo exato de Global Constraints; `url` passa igual; `JSON.stringify` da saída tem só as chaves `title`, `body`, `url` mesmo com `params` extra (`clientName`, `document`); chave desconhecida → throw; `url` `https://evil.com` e `//evil.com` → throw.
- [ ] `errors.test.ts` `classifyPushError`: 410 e 404 → `push_gone`/permanente; 429; 503; 400 e 413 → `provider_rejected`; 401; `{ code: "ECONNRESET" }` → `network_error`; `{ name: "TimeoutError" }` → `provider_timeout`.
- [ ] `channels/push.test.ts` (deps falsas, env com chaves de teste): config vazia → `channel_not_configured`, `send` não chamado; lookup vazio → `subscription_gone`, `send` não chamado; "endpoint not allowlisted is not sent" → `invalid_endpoint`; sucesso → `providerMessageId` `push:<id>`, `send` recebe `{ endpoint, keys }`, payload JSON e `TTL: 86400`; 410 → `delete_gone_push_subscription` chamado com `[id, lease_id]` e `push_gone`; 503 → transitório e sem delete; `console.warn` espionado nunca recebe o endpoint.
- [ ] `dispatch.test.ts`: linha `channel: "push"` vai para o canal push (mesmo estilo dos testes atuais).
- [ ] `dispatch.integration.test.ts` (`vi.mock("web-push")`): inscrição + evento 3 → `runDispatch` → `status = 'sent'`, `recipient` nulo; com 410 → inscrição apagada, `status = 'failed'`, `last_error_code = 'push_gone'`.
- [ ] Rodar: `npx vitest run src/lib/notifications` e `npm run type-check`.
- [ ] Commit (coordenador): `feat(notifications): canal push no worker com web-push`.

### Task 5: Tela Conta › Notificações, menu e botão Sair

**Specialist:** `frontend-specialist` (model `sonnet`). Skills: `/ui-ux-pro-max`, `/vercel:shadcn`.
**Files:** Create `src/app/(portal)/portal/notificacoes/page.tsx`, `src/components/portal/push/push-toggle.tsx`, `src/components/portal/push/push-toggle-state.ts`, `src/components/portal/push/push-toggle-state.test.ts`, `src/components/portal/push/install-guide.tsx`, `src/components/portal/sign-out-button.tsx`. Modify `src/components/portal/account-menu.tsx`, `src/components/providers/idle-timeout.tsx`, `PRODUCT.md` (uma linha em escopo do portal), `docs/design.md` (só se lista as telas de Conta).
**Depends-on:** Task 2, Task 3
**Rules:** AGENTS (pt-BR, reusar componentes), `next/coding-standards` (Server Component por padrão; cliente só no botão), `ui-ux-pro-max` (acessibilidade, alvo de toque), `05-testing` (só a lógica de estado), `docs/design.md`.

**Interfaces (consumes):** `pushSupport`, `readBrowserTraits`, `registerPushServiceWorker`, `currentPushSubscription`, `releaseDevicePushForLogout` (Task 2); `readPushConfig`, `registerPushSubscriptionAction`, `removePushSubscriptionAction`, `getPushSubscriptionStatusAction`, `signOut(formData)` (Task 3).

**Interfaces (produces):**

```ts
// push-toggle-state.ts (puro)
export type PushToggleView = "unavailable" | "unsupported" | "install_first" | "too_old" | "blocked" | "on" | "off";
export function pushToggleView(input: {
	publicKeyPresent: boolean;
	support: PushSupport;
	permission: NotificationPermission; // "default" | "granted" | "denied"
	browserSubscribed: boolean;
	serverSubscribed: boolean;
}): PushToggleView;

// push-toggle.tsx ("use client")
export function PushToggle({ publicKey }: { publicKey: string | null }): JSX.Element;
// install-guide.tsx ("use client")
export function InstallGuide(): JSX.Element;
// sign-out-button.tsx ("use client")
export function PortalSignOutButton(): JSX.Element;
```

Regras:
- `page.tsx`: `getRequiredSession` + `hasPermission(session, "portal:read")` (padrão de `perfil/page.tsx`); `publicKey = readPushConfig(process.env)?.publicKey ?? null` (erro de config → `null` e `console.warn` só com o nome do erro). `PageHeader` "Notificações", cartão do botão, cartão "Instalar no aparelho". `metadata = { title: "Notificações" }`.
- `pushToggleView` (ordem): sem chave → `unavailable`; `support` `unsupported` / `ios_install_required` / `ios_too_old` → `unsupported` / `install_first` / `too_old`; `permission === "denied"` → `blocked`; `browserSubscribed && serverSubscribed` → `on`; senão `off`.
- `PushToggle`: no carregamento lê `currentPushSubscription()` e `getPushSubscriptionStatusAction({ endpoint })`. Ligar: `Notification.requestPermission()` → `registerPushServiceWorker()` → `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })` → `registerPushSubscriptionAction(subscription.toJSON())`; erro da ação → `subscription.unsubscribe()` e mensagem. Desligar: `removePushSubscriptionAction({ endpoint })` e `subscription.unsubscribe()`. Botão com `aria-pressed`, estado ocupado, textos pt-BR por `PushToggleView` (`blocked`: como liberar nas configurações do navegador). `install_first` esconde o botão (spec).
- `InstallGuide`: Android/desktop: escuta `beforeinstallprompt`, botão "Instalar" chama `prompt()`; sem evento, texto "Use o menu do navegador › Instalar app". iPhone: passos "Toque em Compartilhar › Adicionar à Tela de Início", e aviso de iOS 16.4 ou mais novo. Já instalado (`standalone`): "App instalado".
- `AccountMenu`: link `/portal/notificacoes` com ícone `Bell`, rótulo "Notificações", depois de Afiliação e antes de Termos de uso. Troca `<form action={signOut}>` por `<PortalSignOutButton />` (mesmo visual).
- `PortalSignOutButton`: no submit, `endpoint = await releaseDevicePushForLogout()`; envia `FormData` com `pushEndpoint` (quando há) para `signOut`.
- `IdleTimeout`: antes de `signOut`, chama `releaseDevicePushForLogout()` e passa `FormData` com `pushEndpoint`. Sem service worker (painel) o endpoint é `null` e nada muda.

**Test cases:**
- [ ] `push-toggle-state.test.ts`: sem chave → `unavailable` (mesmo com tudo pronto); `ios_install_required` → `install_first`; `ios_too_old` → `too_old`; `unsupported` → `unsupported`; `denied` → `blocked`; navegador inscrito e servidor confirma → `on`; navegador inscrito e servidor nega (outro perfil) → `off`; nada inscrito → `off`.
- [ ] Rodar: `npx vitest run src/components/portal` e `npm run type-check` e `npm run lint`.
- [ ] Commit (coordenador): `feat(portal): tela de notificações push, instalação do app e logout que remove o aparelho`.

---

## Post-deploy follow-up (item único no corpo do PR; não bloqueia merge nem `Closes #n`)

- `(post-deploy)` Em produção com HTTPS e VAPID configurado: Android (Chrome, app instalado) e iPhone (iOS 16.4+, app na Tela de Início) ligam o push em Conta › Notificações e recebem os 4 avisos (sócio autorizou, consulta pronta, comissão recebida, comissão disponível). A tela bloqueada mostra só o texto genérico. Tocar abre `/portal/pesquisas/<id>` ou `/portal/afiliacao`. Depois de Sair, o aparelho não recebe mais avisos.
