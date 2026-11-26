# Autorização com edição de e-mail — Plano de implementação

> **Para agentes:** use superpowers:subagent-driven-development para executar este plano tarefa por tarefa. Passos usam `- [ ]`.

**Goal:** O cliente vê, na página do pedido, quem já autorizou o SCR e quem não. Ele corrige o e-mail de quem foi digitado errado e reenvia o pedido de autorização. Só vale para pedido dele e para autorização `pending`.

**Architecture:** Duas funções SQL `SECURITY DEFINER` (dono `auth_profile_lookup`), no padrão de `cancel_client_order` (025) e `update_order_contact` (044). Uma lista os membros com e-mail mascarado e flags de ação. A outra troca o e-mail ou só reenvia: gira `public_token`, apaga `auth_code`, renova `request_expires_at`, anula o e-mail em fila e audita, tudo na mesma transação. A função não envia. O tick de pedidos (cron de 10 s) emite o link novo porque a autorização fica `pending` sem `auth_code`. Duas Server Actions finas chamam as funções. A UI é a seção "Autorizações" que já existe.

**Tech Stack:** Next.js 14 (App Router), TypeScript, zod, `pg` sem ORM, PostgreSQL com RLS, vitest (integração em `127.0.0.1:54329`), shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-26-fluxo-cliente-final-design.md`, parte 4. A spec foi corrigida junto com este plano (função SQL é obrigatória, RLS não faz o escopo, `expired` não edita, "aba" é a seção existente).

**Independência:** esta parte não depende da compra em etapas (plano 3) nem do pagamento (plano 2). Roda depois do plano 1. A função aceita `awaiting_payment` e `awaiting_authorization`, então funciona antes e depois do plano 2.

## Decisões

| Tema | Decisão | Por quê |
|---|---|---|
| Quem edita | `pending` com `request_expires_at` aberto | É o único estado em que o link ainda vale e o pedido ainda espera. |
| `expired` | Não edita | O tick cancela o pedido com `scr_expired` (`cancelStalledOrders`). Editar não revive o pedido. A tela mostra "Expirada" sem botão. |
| `authorized`, `refused` | Não editam | Mudar o e-mail depois da resposta apagaria uma prova de consentimento. |
| Troca de e-mail | Novo `public_token`, `auth_code` nulo, `request_expires_at = now() + 7 dias`, notificação em fila anulada | Mesmo mecanismo de 044. O link antigo deixa de existir. O prazo novo vale mesmo se o tick atrasar. |
| Envio | Só o tick envia, até cerca de 20 s depois | O cliente não tem política de escrita em `scr_authorizations`, e `issueSelfScrAuthorization` precisa dela. Abrir política exporia token e código. |
| Limite | `client_member_change_limit() = 3` trocas ou reenvios por autorização em 24 h, 2 min entre um e outro | A equipe tem 5. O cliente é a parte não confiável: o risco é spam para o e-mail de terceiros. 3 cobre um erro e duas tentativas. O contador é o `contact_changes_at` da equipe, então os dois lados somam. |
| E-mail igual ao atual | Erro `same_email`, sem gastar o limite | Evita reenvio disfarçado de troca e spam. Para reenviar existe o botão. |
| E-mail do comprador | Erro `contact_is_buyer` em sócio. Membro que é o próprio comprador não edita (`own_account_email`) | Regra D12 de 044: o e-mail da conta não é de terceiro. |
| Teto por destinatário | 3 autorizações `pending` em 24 h por e-mail (`too_many_requests`) | Mesma regra de 044. |
| Reenviar em `awaiting_payment` | `invalid_state` | Nada é enviado antes do pagamento. A UI esconde o botão. |

## Global Constraints

- Mutação e auditoria na mesma transação (`withUserTransaction`). Evento de auditoria no mesmo `begin` da função SQL.
- E-mail completo nunca vai para log, auditoria, mensagem de erro nem resposta. Só a forma mascarada (`account_mask_recipient`).
- SQL parametrizado. Sem ORM. Nenhum `PoolClient` sai do módulo de queries.
- Server Action: zod `safeParse`, sessão, `hasPermission`, query, `revalidatePath`. Retorno `{ error: string | null, id?: string }`.
- Migration nova `db/migrations/NNN_snake_case.sql`. Nunca editar migration aplicada. Hoje o próximo livre é `062`: rode `ls db/migrations` e renumere se outro plano chegou antes.
- Textos de interface, erros e comentários em pt-BR. Identificadores em inglês. Import com `@/`.
- Botões e campos com 44 px no celular (`docs/design.md`).
- Retornos de negócio em `{ ok: false, reason }`. Outros erros lançam e desfazem a transação.
- Implementadores não fazem commit sozinhos: o coordenador commita. Cada implementador usa `model: sonnet`.

## Review Focus

Cinco falhas que um revisor deve procurar, cada uma com o teste na tarefa dona.

1. **Cliente A edita a autorização do cliente B.** Teste na T1: `refuses another client, another bureau, staff and a mismatched consultation` (nada muda no banco, sem linha de auditoria). Na T2: `refuses a staff session before any query`.
2. **Link antigo ainda abre depois da troca.** Teste na T1: `rotates the token and clears the code` (`public_scr_authorization(token antigo)` sem linha, token novo com linha, tick emite com e-mail e token novos) e `voids the queued email of the old address`.
3. **Autorização já `authorized` (ou `refused`, `expired`) é editada.** Teste na T1: `refuses a decided or expired authorization` e `rechecks the state under lock after the signer answers` (o signatário responde entre a leitura da tela e o clique).
4. **E-mail igual ao atual vira reenvio e gasta limite.** Teste na T1: `refuses the same email without using a slot` (comparação sem caixa, `contact_changes_at` continua vazio).
5. **Reenvio em excesso.** Teste na T1: `enforces the cooldown and the daily limit` e `lets only one of two parallel changes through`. Na T3: `memberActionHint` mostra o limite esgotado e esconde os botões.

## Estrutura de arquivos

| Arquivo | Ação | Tarefa |
|---|---|---|
| `db/migrations/065_client_member_email.sql` | criar | T1 |
| `src/lib/orders/member-email.integration.test.ts` | criar | T1 |
| `docs/architecture.md`, `docs/operations/orders.md`, `db/migrations/CLAUDE.md` | editar (1 parágrafo cada) | T1 |
| `src/lib/orders/client-ops.ts` | editar | T2 |
| `src/lib/orders/client-ops.integration.test.ts` | editar | T2 |
| `src/lib/orders/failure-messages.ts` | editar | T2 |
| `src/lib/validators/order.ts` | editar | T2 |
| `src/actions/orders-client.ts`, `src/actions/orders-client.test.ts` | editar | T2 |
| `src/components/orders/order-members.tsx` | editar | T3 |
| `src/components/orders/member-email-actions.tsx` | criar | T3 |
| `src/components/orders/order-rules.ts`, `order-rules.test.ts` | editar | T3 |
| `src/app/(portal)/portal/pesquisas/[id]/page.tsx` | editar (2 props) | T3 |

Ordem: T1, T2, T3 em série. Cada uma consome a assinatura da anterior.

---

## Task 1: Funções SQL, política de auditoria e testes de integração

**Files:**
- Create: `db/migrations/065_client_member_email.sql`
- Create: `src/lib/orders/member-email.integration.test.ts`
- Modify: `docs/architecture.md` (um parágrafo após o da 044), `docs/operations/orders.md`, `db/migrations/CLAUDE.md` (uma linha)

**Depends-on:** plano 1 mergeado (sem dependência de código).
**Agent:** `database-architect`
**Model:** `sonnet`

**Interfaces (SQL):**

```sql
client_member_change_limit() returns integer  -- 3
client_order_members(p_dossier_id uuid) returns table (
  consultation_id uuid, role text, name text, document_masked text,
  email_masked text,            -- null sem e-mail
  scr_status text,              -- igual à 025
  can_edit_email boolean, can_resend boolean, changes_left integer)
update_my_order_member_email(p_dossier_id uuid, p_consultation_id uuid, p_email text)
  returns table (ok boolean, reason text, authorization_id uuid)
-- p_email nulo = reenviar. p_email em branco = invalid_input.
-- reason: not_found | invalid_input | invalid_state | same_email | contact_is_buyer
--         | own_account_email | too_many_requests | resend_too_soon | resend_limit_reached
```

Regras de `client_order_members` (função nova com `drop function client_order_members(uuid)` antes):
- Mesmas linhas, mesma ordem, mesmas guardas da 025: contexto presente, papel `client`, `o.client_profile_id = app_user_id()`. Pedido de outro devolve zero linhas.
- `email_masked = account_mask_recipient('email', lower(coalesce(s.email, c.scr_email)))`.
- `changes_left = greatest(client_member_change_limit() - <trocas em 24 h de s.contact_changes_at>, 0)`.
- `pending_open` = `scr_status = 'pending'` (já cobre prazo aberto).
- `can_resend = pending_open and o.state = 'awaiting_authorization' and changes_left > 0`.
- `can_edit_email = pending_open and o.state in ('awaiting_payment','awaiting_authorization') and changes_left > 0 and não é o Titular do próprio comprador`. Este último usa a regra de 044: `holders.client_profile_id = app_user_id()` e `document_digits = s.document`.
- Refaça `alter function ... owner to auth_profile_lookup`, `revoke all ... from public` e `grant execute ... to app_runtime` (o drop apaga os grants).

SQL exato da função de troca (a forma é o requisito):

```sql
create function client_member_change_limit() returns integer
language sql immutable set search_path = pg_catalog, public as $$ select 3 $$;

create function update_my_order_member_email(p_dossier_id uuid, p_consultation_id uuid, p_email text)
returns table (ok boolean, reason text, authorization_id uuid)
language plpgsql security definer set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  c_email_re constant text := '^[^\s@,;()<>"]+@[^\s@,;()<>"]+\.[^\s@,;()<>"]+$';
  c_cooldown constant interval := interval '2 minutes';
  c_max_recent_requests constant integer := 3;
  c_request_ttl constant interval := interval '7 days';  -- igual a SCR_REQUEST_DAYS
  v_bureau uuid := public.app_bureau_id();
  v_user uuid := public.app_user_id();
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_order record;
  v_member record;
  v_buyer_email text;
  v_is_own boolean;
  v_changes timestamptz[];
  v_recent integer;
  v_shared integer;
begin
  if not public.app_context_present() or v_bureau is null or v_user is null
     or public.app_user_role() is distinct from 'client' or p_dossier_id is null or p_consultation_id is null then
    return query select false, 'not_found'::text, null::uuid; return;
  end if;
  if p_email is not null and (v_email is null or length(v_email) > 254 or v_email !~ c_email_re) then
    return query select false, 'invalid_input'::text, null::uuid; return;
  end if;

  -- Posse do pedido na própria consulta de trava. Ordem de trava de 044: pedido, depois autorização.
  select o.state into v_order from public.dossier_orders o
   where o.dossier_id = p_dossier_id and o.bureau_id = v_bureau and o.client_profile_id = v_user
     for update;
  if not found then return query select false, 'not_found'::text, null::uuid; return; end if;
  if v_order.state not in ('awaiting_payment', 'awaiting_authorization') then
    return query select false, 'invalid_state'::text, null::uuid; return;
  end if;

  select c.status::text as consultation_status, s.id as auth_id, s.status::text as auth_status, s.document,
         s.email, s.request_expires_at, s.contact_changes_at into v_member
    from public.consultations c
    join public.scr_authorizations s on s.id = c.scr_authorization_id
   where c.id = p_consultation_id and c.dossier_id = p_dossier_id and c.bureau_id = v_bureau
     and s.bureau_id = v_bureau and s.channel = 'internal'
     for update of s;
  if not found then return query select false, 'not_found'::text, null::uuid; return; end if;
  if v_member.consultation_status <> 'pending_authorization' or v_member.auth_status <> 'pending'
     or (v_member.request_expires_at is not null and v_member.request_expires_at <= now()) then
    return query select false, 'invalid_state'::text, null::uuid; return;
  end if;

  if v_email is null then  -- reenviar
    if v_order.state = 'awaiting_payment' or v_member.email is null then
      return query select false, 'invalid_state'::text, null::uuid; return;
    end if;
  else                     -- corrigir
    v_is_own := exists (select 1 from public.holders h
                         where h.bureau_id = v_bureau and h.client_profile_id = v_user
                           and h.document_digits = v_member.document);
    if v_is_own then return query select false, 'own_account_email'::text, null::uuid; return; end if;
    if v_email = lower(v_member.email) then
      return query select false, 'same_email'::text, null::uuid; return;
    end if;
    select lower(p.email) into v_buyer_email from public.profiles p where p.id = v_user and p.bureau_id = v_bureau;
    if v_email = v_buyer_email then
      return query select false, 'contact_is_buyer'::text, null::uuid; return;
    end if;
  end if;

  v_changes := array(select t from unnest(v_member.contact_changes_at) t where t > now() - interval '24 hours');
  if exists (select 1 from unnest(v_changes) t where t > now() - c_cooldown) then
    return query select false, 'resend_too_soon'::text, null::uuid; return;
  end if;
  if cardinality(v_changes) >= public.client_member_change_limit() then
    return query select false, 'resend_limit_reached'::text, null::uuid; return;
  end if;

  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended('recipient_cap:' || v_bureau::text || ':' || v_email, 0));
    select count(*) into v_recent from public.scr_authorizations s
     where s.bureau_id = v_bureau and s.id <> v_member.auth_id and s.status = 'pending'
       and s.requested_at > now() - interval '24 hours' and lower(s.email) = v_email;
    if v_recent >= c_max_recent_requests then
      return query select false, 'too_many_requests'::text, null::uuid; return;
    end if;
  end if;

  update public.scr_authorizations
     set email = coalesce(v_email, email), public_token = gen_random_uuid(), auth_code = null,
         request_expires_at = case when v_order.state = 'awaiting_authorization' then now() + c_request_ttl
                                   else request_expires_at end,
         last_checked_at = now(), contact_changes_at = v_changes || now()
   where id = v_member.auth_id;
  update public.consultations set scr_email = coalesce(v_email, scr_email)
   where scr_authorization_id = v_member.auth_id and status = 'pending_authorization';
  perform public.supersede_notifications('scr_authorization', 'scr_authorization:' || v_member.auth_id::text);

  select count(distinct c.dossier_id) into v_shared
    from public.consultations c join public.dossier_orders o on o.dossier_id = c.dossier_id and o.bureau_id = v_bureau
   where c.bureau_id = v_bureau and c.scr_authorization_id = v_member.auth_id
     and c.status = 'pending_authorization' and o.state in ('awaiting_payment', 'awaiting_authorization');
  insert into public.audit_logs (bureau_id, user_id, action, table_name, record_id, metadata)
  values (v_bureau, v_user,
          case when v_email is null then 'order.member_resend' else 'order.member_email_update' end,
          'dossier_orders', p_dossier_id,
          jsonb_build_object('consultation_id', p_consultation_id, 'authorization_id', v_member.auth_id,
            'previous_email_masked', case when v_member.email is null then null
                                          else public.account_mask_recipient('email', lower(v_member.email)) end,
            'email_masked', public.account_mask_recipient('email', coalesce(v_email, lower(v_member.email))),
            'shared_dossiers', v_shared));
  return query select true, null::text, v_member.auth_id;
end
$$;

alter function update_my_order_member_email(uuid, uuid, text) owner to auth_profile_lookup;
revoke all on function update_my_order_member_email(uuid, uuid, text) from public;
grant execute on function update_my_order_member_email(uuid, uuid, text) to app_runtime;
-- Novo: 044 não precisava gravar o prazo.
grant update (request_expires_at) on public.scr_authorizations to auth_profile_lookup;

create policy audit_logs_client_member_email_insert on audit_logs for insert to auth_profile_lookup with check (
  action in ('order.member_email_update', 'order.member_resend') and table_name = 'dossier_orders'
  and support_session_id is null and app_user_role() = 'client'
  and bureau_id = app_bureau_id() and user_id = app_user_id()
  and exists (select 1 from dossier_orders o
               where o.dossier_id = audit_logs.record_id and o.bureau_id = audit_logs.bureau_id
                 and o.client_profile_id = app_user_id()));
```

O implementador confere se `auth_profile_lookup` já tem `select` em `profiles.email`, `holders.client_profile_id`, `holders.document_digits`, `dossier_orders.client_profile_id` e `consultations.status` (044 usa todos). Se faltar um, o teste de integração falha com `42501`; adicione só o `grant select (coluna)` que faltar.

Casos de teste (arquivo `src/lib/orders/member-email.integration.test.ts`; copie os helpers `newTenant`, `place`, `companyInput` de `client-ops.integration.test.ts`, sem extrair). Chame as funções com `withUserTransaction(identity, c => c.query("select ok, reason, authorization_id from update_my_order_member_email($1,$2,$3)", ...))`:

- `rotates the token and clears the code`: pedido de empresa com sócio A. Troca A para `novo@example.com`. Espera `ok: true`. Pelo `owner`: `email = novo@example.com`, `public_token` diferente, `auth_code` nulo, `request_expires_at > now() + 6 dias`, `contact_changes_at` com 1 item, `consultations.scr_email` novo. `public_scr_authorization(token antigo, 'internal')` sem linha. Com token novo, uma linha. `listScrRequestsToIssue(staff)` devolve a autorização com o e-mail e o token novos.
- `voids the queued email of the old address`: antes da troca, emita com `issueSelfScrAuthorization` (identidade da equipe) e confirme a notificação em fila. Depois da troca, a notificação de `reference = 'scr_authorization:<id>'` está anulada (status que `supersede_notifications` grava em 020).
- `writes one audit event with masked emails only`: uma linha `order.member_email_update`, `record_id` = dossiê, `metadata.email_masked` = `n***@example.com`, `previous_email_masked` mascarado, `shared_dossiers` = 1. O JSON da linha não contém o e-mail novo, o antigo nem os dígitos do CPF.
- `refuses another client, another bureau, staff and a mismatched consultation`: outro cliente do mesmo Bureau, cliente de outro Bureau, operador da equipe, e o par (pedido próprio, consulta de outro pedido do mesmo cliente). Todos `{ ok: false, reason: 'not_found' }`. O banco não muda: mesmo `email`, mesmo `public_token`, `contact_changes_at` vazio, zero linhas `order.member_%` em `audit_logs`.
- `refuses a decided or expired authorization`: `authorized`, `not_authorized` e `request_expires_at` vencido dão `invalid_state`. Estado do pedido `ready` também. Nada muda.
- `rechecks the state under lock after the signer answers`: leia `client_order_members` (flag `can_edit_email = true`), depois autorize pelo `owner`, depois chame a função. Espera `invalid_state`.
- `refuses the same email without using a slot`: mesmo e-mail com caixa diferente dá `same_email`. `contact_changes_at` continua vazio.
- `refuses an invalid or blank email`: `joao@` e `'   '` dão `invalid_input`.
- `refuses the buyer's email and the own-account member`: sócio com o e-mail da conta do comprador dá `contact_is_buyer`. Pedido PF próprio (Titular = comprador): corrigir dá `own_account_email`, reenviar dá `ok: true`.
- `enforces the cooldown and the daily limit`: duas trocas seguidas, a segunda dá `resend_too_soon`. Recue `contact_changes_at` pelo `owner` (mais de 2 min) e troque até 3 no total. A 4ª dá `resend_limit_reached`. `client_order_members` mostra `changes_left = 0`, `can_edit_email = false`, `can_resend = false`. `client_member_change_limit()` devolve 3.
- `lets only one of two parallel changes through`: duas chamadas com `Promise.all` e e-mails diferentes. Um `ok`, o outro `resend_too_soon`.
- `resends without a new email`: e-mail nulo gira o token, mantém o e-mail, grava `order.member_resend`. Com o pedido em `awaiting_payment` (via `owner`) dá `invalid_state`. Em `awaiting_payment` a troca de e-mail funciona e não muda `request_expires_at`.
- `caps pending requests per recipient`: 3 outras autorizações `pending` para o mesmo e-mail em 24 h. A troca dá `too_many_requests`.
- `lists members with masked email and action flags`: sócio pendente tem `can_edit_email` e `can_resend` verdadeiros, `email_masked` com `***@`, `consultation_id` preenchido. O JSON do resultado não contém e-mail completo nem CPF. Outro cliente, outro Bureau e equipe recebem zero linhas.

- [ ] Escrever o arquivo de teste com os casos acima. Rodar `npx vitest run src/lib/orders/member-email.integration.test.ts` e ver todos falharem (funções inexistentes).
- [ ] Criar `db/migrations/065_client_member_email.sql` com o SQL acima e a nova `client_order_members`. Rodar `npm run db:migrate`.
- [ ] Rodar o mesmo comando e ver todos passarem. Rodar também `npx vitest run src/lib/orders/client-ops.integration.test.ts src/lib/orders/queries.integration.test.ts` (as 025 e 044 não podem quebrar).
- [ ] Atualizar `docs/architecture.md`, `docs/operations/orders.md` e `db/migrations/CLAUDE.md` com: as duas funções, o limite 3 em 24 h, o motivo de o envio ser do tick, e o `expired` não editar.
- [ ] Commit (coordenador): `feat(autorizacao): cliente corrige o e-mail de quem autoriza`.

---

## Task 2: Wrapper, schemas, mensagens e Server Actions

**Files:**
- Modify: `src/lib/orders/client-ops.ts`
- Modify: `src/lib/orders/client-ops.integration.test.ts`
- Modify: `src/lib/orders/failure-messages.ts`
- Modify: `src/lib/validators/order.ts`
- Modify: `src/actions/orders-client.ts` (acrescente no fim; não toque em `openClientOrderAction`, o plano 1 edita o início do arquivo)
- Modify: `src/actions/orders-client.test.ts`

**Depends-on:** T1.
**Agent:** `backend-specialist`
**Model:** `sonnet`

**Interfaces:**

```ts
// src/lib/orders/client-ops.ts
export type OrderMember = {
	consultationId: string;
	role: OrderMemberRole;
	name: string | null;
	documentMasked: string;
	emailMasked: string | null;
	scrStatus: OrderMemberScrStatus;
	canEditEmail: boolean;
	canResend: boolean;
	changesLeft: number;
};
export type MemberEmailFailure =
	| "not_found" | "invalid_input" | "invalid_state" | "same_email" | "contact_is_buyer"
	| "own_account_email" | "too_many_requests" | "resend_too_soon" | "resend_limit_reached";
export async function updateMyOrderMemberEmail(
	client: PoolClient,
	input: { dossierId: string; consultationId: string; email: string | null },
): Promise<{ ok: true; authorizationId: string } | { ok: false; reason: MemberEmailFailure }>;
// Motivo fora da lista: lança Error("unexpected updateMyOrderMemberEmail reason") e a transação volta (padrão de contact.ts).

// src/lib/validators/order.ts
export const updateMemberEmailSchema: z.ZodObject<{ dossierId; consultationId; email }>;  // email obrigatório: emailSchema (trim, formato, 254)
export const resendMemberSchema: z.ZodObject<{ dossierId; consultationId }>;

// src/lib/orders/failure-messages.ts
export const MEMBER_EMAIL_MESSAGES: Record<string, string>;  // pt-BR, uma por motivo, sem e-mail dentro

// src/actions/orders-client.ts
export async function updateMyMemberEmailAction(values: unknown): Promise<ActionResult>;
export async function resendMyMemberAuthorizationAction(values: unknown): Promise<ActionResult>;
// Ordem: safeParse -> requireClient() (sessão + papel client + portal:write) -> withUserTransaction -> mapa de motivos
// -> revalidatePath(`/portal/pesquisas/${dossierId}`) -> { error: null, id: dossierId }.
```

Mensagens (`MEMBER_EMAIL_MESSAGES`):

| reason | texto |
|---|---|
| `not_found` | Pedido não encontrado. |
| `invalid_input` | E-mail inválido. Confira e tente de novo. |
| `invalid_state` | Esta autorização não pode mais ser alterada. Recarregue a página. |
| `same_email` | Este já é o e-mail desta autorização. Use Reenviar. |
| `contact_is_buyer` | Informe o e-mail da outra pessoa, não o seu. |
| `own_account_email` | O e-mail desta pessoa vem da sua conta e não pode ser trocado aqui. |
| `too_many_requests` | Este e-mail já recebeu pedidos de autorização recentes. Tente novamente amanhã. |
| `resend_too_soon` | O pedido acabou de ser enviado. Aguarde 2 minutos para tentar de novo. |
| `resend_limit_reached` | Limite de envios de hoje atingido para esta pessoa. Tente amanhã. |

Log de falha: reutilize o `logFailure` do arquivo (só passo e motivo, nunca e-mail nem mensagem do driver).

Casos de teste:
- `updateMyMemberEmailAction rejects a malformed or blank email without a query`: `joao@` e `""` dão `error` ("E-mail inválido."), wrapper não chamado.
- `rejects ids that are not uuids`: `ORDER_NOT_FOUND`, wrapper não chamado.
- `refuses a staff session before any query`: `state.role = "operator"` dá `Ação não permitida.`, wrapper não chamado. O mesmo para a ação de reenvio.
- `maps every failure reason to a pt-BR message`: `it.each` pelos 9 motivos. A mensagem existe e não contém `@`.
- `returns the dossier id and revalidates the order page on success`: `{ error: null, id }` e `revalidatePath` com `/portal/pesquisas/<id>`.
- `resend passes a null email to the wrapper`.
- `does not log the email when the query throws`: o wrapper lança `Error` com o e-mail na mensagem. O `console.error` espiado não recebe o e-mail em nenhum argumento. A resposta é `ORDER_FAILED`.
- Integração (em `client-ops.integration.test.ts`): atualizar o `toEqual` de `listMyOrderMembers` para o formato novo (`consultationId` com `expect.any(String)`, `emailMasked`, flags, `changesLeft`). Acrescentar `updateMyOrderMemberEmail changes the email of an own order and returns not_found for another client's`.

- [ ] Escrever os testes acima. Rodar `npx vitest run src/actions/orders-client.test.ts src/lib/orders/client-ops.integration.test.ts` e ver falharem.
- [ ] Implementar as assinaturas acima. `listMyOrderMembers` passa a selecionar as colunas novas por nome.
- [ ] Rodar o mesmo comando e ver passarem. Rodar `npm run type-check` e `npm run lint`.
- [ ] Commit (coordenador): `feat(autorizacao): ações do cliente para corrigir e reenviar o e-mail`.

---

## Task 3: Interface na seção "Autorizações"

**Files:**
- Modify: `src/components/orders/order-members.tsx`
- Create: `src/components/orders/member-email-actions.tsx`
- Modify: `src/components/orders/order-rules.ts`
- Modify: `src/components/orders/order-rules.test.ts`
- Modify: `src/app/(portal)/portal/pesquisas/[id]/page.tsx` (passa `dossierId` e `orderState` ao `OrderMembers`; o plano 2 também edita este arquivo, faça só estas duas props)

**Depends-on:** T2.
**Agent:** `frontend-specialist`
**Model:** `sonnet`

**Interfaces:**

```ts
// order-rules.ts. Texto de apoio por pessoa; nulo quando não há o que dizer.
export function memberActionHint(m: Pick<OrderMember, "scrStatus" | "canEditEmail" | "canResend" | "changesLeft">): string | null;

// order-members.tsx (continua Server Component)
export function OrderMembers(props: { members: OrderMember[]; mode: OrderMode; dossierId: string; orderState: OrderState }): JSX.Element | null;

// member-email-actions.tsx ("use client")
export function MemberEmailActions(props: { dossierId: string; member: OrderMember; orderState: OrderState }): JSX.Element | null;
// Nulo quando !canEditEmail && !canResend. Botões "Corrigir e-mail" e "Reenviar" (cada um só se a flag permite).
// "Corrigir e-mail" abre o Dialog com um campo de e-mail (type="email", autoComplete="off") e o texto
// "O link enviado ao e-mail antigo deixa de funcionar." Chama updateMyMemberEmailAction / resendMyMemberAuthorizationAction
// dentro de useTransition, mostra o erro da ação no Dialog, e router.refresh() no sucesso.
```

Regras de `memberActionHint`:
- `scrStatus !== "pending"`: nulo (para `expired`, a linha já mostra o selo "Expirada").
- `changesLeft === 0`: "Limite de envios de hoje atingido. Tente amanhã."
- `canEditEmail || canResend`: `Restam ${changesLeft} envios hoje.` (singular com 1: "Resta 1 envio hoje.")
- Caso contrário (membro que é o próprio comprador): "E-mail da sua conta."

Regras de tela:
- Cada linha mostra nome, papel, documento mascarado, `emailMasked ?? "Sem e-mail"` e o `StatusBadge` já existente.
- Chave da linha: `consultationId`.
- Sucesso: texto em `aria-live="polite"`. Em `awaiting_authorization`: "Pedido enviado. O e-mail chega em instantes." Em `awaiting_payment`: "E-mail salvo. O pedido de autorização sai depois do pagamento."
- Botão e campo com altura mínima de 44 px (`min-h-11`). Sem texto técnico para o cliente.
- A UI nunca calcula permissão: ela só lê `canEditEmail`, `canResend` e `changesLeft`. O servidor decide de novo ao receber a ação.

Casos de teste (`order-rules.test.ts`): `memberActionHint is null for authorized, refused and expired`, `shows the exhausted limit and no buttons when changesLeft is 0`, `uses the singular with one send left`, `says the email comes from the account for the buyer's own member`.

- [ ] Escrever os testes de `memberActionHint`. Rodar `npx vitest run src/components/orders/order-rules.test.ts` e ver falharem.
- [ ] Implementar `memberActionHint`, o componente cliente, a mudança em `OrderMembers` e as duas props na página. Ver o teste passar.
- [ ] Rodar `npm run type-check`, `npm run lint` e `graphify update .`.
- [ ] Conferir no navegador (Playwright MCP) com um pedido de empresa e um sócio pendente: corrigir, reenviar, erro de e-mail inválido, tela de 360 px. Sem teste E2E novo: o seed de pedido de empresa não existe em `e2e/`.
- [ ] Commit (coordenador): `feat(portal): botões Corrigir e-mail e Reenviar na seção Autorizações`.

---

## Post-deploy follow-up (item do corpo do PR, não bloqueia merge)

- (post-deploy) O e-mail com o link novo chega ao endereço corrigido até cerca de 30 s depois, e o link antigo abre a página "não encontrada". Só o SMTP e o cron de produção confirmam.
- (post-deploy) Conferir em `audit_logs` que `order.member_email_update` não traz e-mail completo.

## Riscos e pontos aceitos

- `update_my_order_member_email` repete regras de `update_order_contact` (044). Unificar exigiria `create or replace` de uma função de equipe já testada. A duplicação fica documentada nos dois lados.
- Sem teto global por cliente: o limite é por autorização (3 em 24 h) e por destinatário (3). O teto de pedidos por dia (`too_many_orders`) limita o número de autorizações novas.
- `resendScr` (`src/actions/scr.ts`) e `markScrPending` aceitam id solto. O papel `client` não tem política em `scr_authorizations`, então a RLS bloqueia. Fora do escopo: apenas registrado.
- A autorização pode ser compartilhada entre pedidos do mesmo cliente (D10). A troca vale para todos os que ainda esperam. A auditoria grava `shared_dossiers` com a contagem.

## Auto-revisão

- Cobertura da spec (parte 4): e-mail mascarado e status por pessoa (T1 função + T3 tela); ação de corrigir com zod, sessão, permissão, posse do pedido, auditoria na mesma transação (T1 + T2); reenviar sem editar (T1 + T2 + T3); `authorized` e `refused` não editam (T1); `expired` decidido (tabela de decisões).
- Nomes: `update_my_order_member_email`, `updateMyOrderMemberEmail`, `updateMyMemberEmailAction`, `resendMyMemberAuthorizationAction`, `MemberEmailFailure`, `MEMBER_EMAIL_MESSAGES`, `client_member_change_limit`, `memberActionHint`: iguais em todas as tarefas.
- Proporção: 3 tarefas, 1 migration, 2 ações, 1 componente novo.
