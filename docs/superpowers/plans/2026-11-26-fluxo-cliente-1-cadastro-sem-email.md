# Cadastro sem e-mail — Plano de implementação

> **Para agentes:** use `superpowers:subagent-driven-development`. Implementadores não commitam sozinhos: o coordenador commita uma vez por tarefa, em ordem, com o HEAD capturado antes de cada commit. Passos usam checkbox (`- [ ]`).

**Goal:** O cliente se cadastra sem receber e-mail de confirmação e compra, recarrega e confirma o celular sem e-mail verificado.

**Architecture:** Uma migration nova (`062`) troca `register_client` (sem desafio de e-mail) e `request_phone_verification` (sem a trava de e-mail verificado). O app remove as travas de e-mail em `openClientOrderAction` e `runCheckout`, o banner do portal e o campo `emailVerified`. `confirm_email_verification`, `request_email_verification` e a página `/cadastro/confirmar-email` ficam, para links antigos já enviados.

**Tech Stack:** Next.js 14.2 (App Router), TypeScript, `pg` (SQL puro, sem ORM), PostgreSQL, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-fluxo-cliente-final-design.md` (Parte 1).

## Correções à spec (conferidas no código)

- A versão atual de `register_client` é a da **026** (14 parâmetros, `p_referral_code`), não a da 021. Nenhuma migration depois da 026 a redefine.
- `src/actions/credits-topup.ts` **não** tem trava de e-mail. A trava da recarga está em `runCheckout`, `src/lib/payments/checkout.ts:143`. Não há mudança em `credits-topup.ts`.
- **Falta na spec:** `request_phone_verification` (021:446-459) também exige `email_verified` e devolve `email_not_verified`. Sem mudar essa função, o cliente novo não confirma o celular. A razão `email_not_verified` está em `src/actions/account.ts:47,61` e `src/lib/account/queries.ts:204`.
- `src/actions/register.test.ts` não muda: a action ainda gera `emailToken` e passa à função (veja o atalho abaixo).
- `perfil/page.tsx`, `nova/page.tsx` e `(portal-onboarding)/layout.tsx` leem `getClientAccountStatus`, mas não usam `emailVerified`.
- Textos que citam a confirmação de e-mail: `PRODUCT.md:29` e `src/components/portal/landing/landing-trust.tsx:6`.

## Global Constraints

- Migration: `db/migrations/062_client_register_no_email.sql` (próximo número livre; a última é `061`). Nunca editar a 021 nem a 026.
- Use `create or replace function` com a mesma assinatura: dono (`auth_profile_lookup`), `revoke` e `grant` ficam como estão.
- Atalho: `register_client` mantém os 14 parâmetros. `p_email_token` e `p_site_url` ficam sem uso (shortcut: remover em migration futura se atrapalhar).
- SQL parametrizado. `withUserTransaction({ userId, role }, fn)` em toda query do app.
- Auditoria na mesma transação de cada mutação. `client.register` continua gravado.
- Nunca CPF/CNPJ completo em log, auditoria, erro ou export.
- Texto de interface, erro e comentário em pt-BR. Identificadores em inglês.
- Testes: `src/**/*.test.ts` ao lado do código. `npm test` roda `db:test:migrate` antes (Postgres em `127.0.0.1:54329`, `docker-compose.dev.yml`).
- Comandos: `npm run test`, `npm run type-check`, `npm run lint`, `npm run db:migrate`.
- Commits convencionais, uma linha. Sem push.

## Review Focus

Modos de falha que nenhum teste isolado de tarefa pega. O teste que cobre cada um está na tarefa dona.

1. Cadastro novo ainda enfileira o e-mail antigo ou grava desafio. Coberto em T1 (`register_client creates no email challenge and no notification`) e em T2 (`register.integration`).
2. Cliente com e-mail não verificado ainda não confirma o celular (trava esquecida pela spec). Coberto em T1 (`request_phone_verification works with an unverified e-mail`).
3. Links antigos de confirmação param de funcionar. Coberto em T1 (bloco `email verification` usa `request_email_verification` e depois confirma).
4. A migration muda dono ou `grant` de `register_client`: o cadastro público quebra com erro de permissão em produção. Coberto em T1 (rodar `rls.integration.test.ts` e `core.integration.test.ts`; `callRegister` usa o pool `app_runtime`).
5. Uma trava de e-mail sobra em um caminho só (pedido online ou PIX de recarga). Coberto em T2 (`orders-client.test.ts`, `checkout.integration.test.ts`: cliente com `email_verified = false` abre pedido e gera PIX).

---

## Tarefa 1: Migration 062 e testes SQL

**Agent:** database-architect
**Model:** sonnet
**Depends-on:** none
**Files:**
- Criar: `db/migrations/062_client_register_no_email.sql`
- Modificar (testes): `src/lib/account/account.integration.test.ts`
- Modificar (docs): `docs/architecture.md` (bullet novo após o da 026/060 sobre a 062), `db/migrations/CLAUDE.md` (uma linha para a 062)

**Interfaces:**
- Consome: nada novo.
- Produz (assinaturas exatas, iguais às atuais):
  - `register_client(p_slug text, p_type text, p_name text, p_document_digits text, p_email text, p_phone_e164 text, p_password_hash text, p_terms_version integer, p_privacy_version integer, p_ip inet, p_user_agent text, p_email_token text, p_site_url text, p_referral_code text default null) returns table (ok boolean, reason text, user_id uuid)`. Corpo da 026 (linhas 389-512) sem `v_reason text;` e sem o bloco `v_reason := public.account_issue_email_challenge(...)` (026:504-507). O usuário nasce com `email_verified = false`. Nenhuma linha em `verification_challenges` nem em `notifications`.
  - `request_phone_verification(p_user_id uuid, p_phone_e164 text, p_code text) returns table (ok boolean, reason text)`. Corpo da 021 (linhas 423-506) sem `u.email_verified` no select, sem o `join "user"` se não for mais usado, e sem o bloco `if not v_p.email_verified` (021:456-459). Razões restantes: `not_allowed`, `invalid_input`, `already_verified`, `cooldown`, `too_many`.

- [ ] Em `account.integration.test.ts`, escrever os testes novos e ver falhar:
  - `register_client creates no email challenge and no notification`: após `callRegister` ok, `verification_challenges` com `kind = 'email'` = 0; `notifications` com `reference = 'profile:<uid>'` = 0; `"user".email_verified` = `false`; auditoria `client.register` = 1.
  - `request_phone_verification works with an unverified e-mail`: `registerOk(A)` e `requestPhone(r, r.phone, newCode())` devolve `{ ok: true, reason: null }`. Substitui o teste `phone request is refused until the email is verified`. Apague o helper `registerVerified` se ficar sem uso.
- [ ] Ajustar os testes que contavam com o desafio criado no cadastro:
  - No fim de `register_client creates every row in one transaction`: contagens de desafio e de notificação passam de 1 para 0.
  - Apagar `register_client enqueues email_verification with the token url and no document`. Mover a checagem "o documento não aparece em params nem em auditoria" para o teste novo, sobre `request_email_verification`.
  - Criar helper `registerWithEmailLink(tenant)`: `registerOk` seguido de `requestEmail(r, r.token)` com resultado `{ ok: true, reason: null }`. Usar nos testes de `challenge stores only the sha256`, no bloco `email verification` e no de cooldown (o primeiro pedido agora é `ok`; o segundo, `cooldown`).
- [ ] Rodar e ver falhar: `npm run test -- src/lib/account/account.integration.test.ts` (falha: desafio e notificação ainda existem; celular recusado com `email_not_verified`).
- [ ] Escrever `062_client_register_no_email.sql` com as duas funções acima. Cabeçalho de comentário em pt-BR: o que muda e que `request_email_verification` e `confirm_email_verification` ficam para links antigos.
- [ ] Rodar e ver passar: `npm run test -- src/lib/account/account.integration.test.ts src/lib/db/rls.integration.test.ts src/lib/affiliates/core.integration.test.ts`.
- [ ] Atualizar `docs/architecture.md` e `db/migrations/CLAUDE.md`.
- [ ] Commit: `feat(cadastro): remove e-mail de confirmação do register_client e a trava do celular`

---

## Tarefa 2: Remover as travas e o banner no app

**Agent:** backend-specialist
**Model:** sonnet
**Depends-on:** 1
**Files:**
- Modificar: `src/actions/orders-client.ts` (linhas 28 e 84), `src/lib/payments/checkout.ts` (linhas 79 e 143, mais o comentário da 142), `src/actions/account.ts` (remover `resendEmailVerificationAction`, a razão `email_not_verified` e imports que sobrarem), `src/lib/account/queries.ts` (remover `emailVerified` de `ClientAccountStatus` e `StatusRow`, `u.email_verified` do select, o `requestEmailVerification` e `email_not_verified` da lista de razões), `src/app/(portal)/layout.tsx` (linhas 3 e 33), `src/app/(portal)/portal/credits/page.tsx` (linhas 13, 35 e 61-67)
- Apagar: `src/components/account/email-verification-banner.tsx`
- Testar: `src/actions/orders-client.test.ts`, `src/lib/payments/checkout.test.ts`, `src/lib/payments/checkout.integration.test.ts`, `src/actions/account.test.ts`, `src/lib/account/queries.integration.test.ts`, `src/actions/portal.integration.test.ts`, `src/actions/register.integration.test.ts`

**Interfaces:**
- Consome: T1 (cadastro sem desafio; celular sem trava de e-mail).
- Produz:
  - `ClientAccountStatus = { phoneE164: string | null; phoneVerified: boolean; notificationChannel: "email" | "whatsapp"; termsAccepted: boolean; documentMasked: string | null }` (sem `emailVerified`).
  - `openClientOrderAction(values: unknown): Promise<ActionResult>` e `runCheckout(...)` sem recusa por e-mail.
  - Removidos: `resendEmailVerificationAction`, `requestEmailVerification` (TS), `EmailVerificationBanner`. O SQL `request_email_verification` continua.
  - `credits/page.tsx`: `{hasPermission(session, "credits:topup") && <ClientTopupDialog priceRows={priceRows} />}`; a página não lê mais `getClientAccountStatus`.

- [ ] Escrever os testes novos e ver falhar (o campo `emailVerified` ainda existe nos mocks):
  - `orders-client.test.ts`: trocar `refuses a client with an unverified e-mail and does not place the order` por `places the order for a client with an unverified e-mail`: status `{ termsAccepted: true, emailVerified: false }`, espera sucesso e `placeOrder` chamado uma vez.
  - `checkout.test.ts`: trocar `blocks a client with an unverified e-mail before any reservation` por `does not block a client with an unverified e-mail`: `s.emailVerified` devolve `{ emailVerified: false }`, espera `result.error` nulo e `s.reserve` chamado.
  - `checkout.integration.test.ts`: apagar o helper `verifyEmail` e as chamadas. Os casos de PIX de recarga passam com `email_verified = false`.
  - `portal.integration.test.ts` (linha 233): apagar o `update "user" set email_verified = true`. O pedido online abre.
  - `register.integration.test.ts`: reescrever o primeiro teste como `registers end to end with no confirmation e-mail`: mantém as checagens de senha, perfil, titular e aceites; espera `email_verified = false`, zero linhas em `notifications` com `reference = 'profile:<id>'` e zero desafios de e-mail. Remover o trecho que confirma o token.
  - `account.test.ts`: apagar os casos de `resendEmailVerificationAction` e a linha `email_not_verified` (linha 212).
- [ ] Rodar e ver falhar: `npm run test -- src/actions/orders-client.test.ts src/lib/payments/checkout.test.ts src/actions/register.integration.test.ts`.
- [ ] Remover as travas, o banner, o campo `emailVerified` e as importações que sobrarem. Em `queries.integration.test.ts` (linha 85), tirar `emailVerified: false` do `toEqual`.
- [ ] Rodar e ver passar: `npm run test -- src/actions src/lib/account src/lib/payments`, depois `npm run type-check` e `npm run lint`. Corrigir todo erro, mesmo de arquivo que você não editou.
- [ ] Commit: `feat(cadastro): remove travas de e-mail verificado e o banner do portal`

---

## Tarefa 3: e2e, texto de venda e produto

**Agent:** frontend-specialist
**Model:** haiku
**Depends-on:** 1, 2
**Files:**
- Modificar: `e2e/global-setup.ts` (linha 53), `e2e/affiliate.spec.ts` (linha 71 e o comentário da 70), `src/components/portal/landing/landing-trust.tsx` (linha 6), `PRODUCT.md` (linha 29)

**Interfaces:**
- Consome: T1 e T2 (usuário sem e-mail verificado compra).
- Produz: usuários semeados no e2e com `email_verified` no padrão do banco (`false`). Texto da landing: `Realize seu cadastro na plataforma Rainha Cred e confirme seu número de celular por meio do código enviado pelo WhatsApp.`

- [ ] `e2e/global-setup.ts`: o `insert into "user"` deixa de passar `email_verified` (o padrão é `false`). Assim o e2e prova que nenhuma trava sobrou.
- [ ] `e2e/affiliate.spec.ts`: apagar `update "user" set email_verified = true ...` e ajustar o comentário para "Comprar exige créditos; a comissão exige celular confirmado".
- [ ] Ajustar o texto da landing e a linha de cadastro em `PRODUCT.md` (sem "confirmação de e-mail").
- [ ] Rodar: `npm run type-check`, `npm run lint` e `npm run test -- src/components/portal`. Se o ambiente de e2e estiver de pé: `npx playwright test e2e/affiliate.spec.ts`. Sem ambiente, deixar para o CI.
- [ ] Commit: `test(cadastro): e2e sem e-mail verificado e texto de cadastro`

---

## Post-deploy follow-up

- (post-deploy) Cadastrar um cliente de teste em produção: nenhum e-mail de confirmação sai, e o cliente compra e confirma o celular.
- (post-deploy) Abrir um link `/cadastro/confirmar-email` já enviado antes do deploy: a confirmação ainda funciona.
