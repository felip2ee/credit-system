# Telas e regras do afiliado (bureau indicador e afiliado de link) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao superadmin a indicação entre bureaus, ao afiliado a escolha entre receber por conta Asaas ou por chave Pix, e ao dono do bureau o interruptor que mostra ou esconde a seção de afiliado.

**Architecture:** Usa as tabelas e o motor da Parte 1 (`bureau_referrals`, `payout_method`, `asaas_wallet_id`, `affiliate_enabled`, `buildSplitPlan`). Só telas, Server Actions e regras de acesso.

**Tech Stack:** Next.js 14 App Router, TypeScript, `pg`, zod, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-26-afiliado-bureaus-design.md`. Parte 1: `docs/superpowers/plans/2026-11-26-afiliado-bureaus-1-split-na-entrada.md`.

## Global Constraints

- Depende da Task 1 da Parte 1 (schema). Não cria migração própria.
- Cada query roda em `withUserTransaction({ userId, role }, fn)`. Auditoria na mesma transação de cada mutação.
- `walletId` e chave Pix só mascarados em logs, auditoria e erros.
- Server Action: zod `safeParse`, sessão, `hasPermission(role, "<resource>:<verb>")`, query, `revalidatePath`. Retorno `{ error: string | null, id? }`.
- Textos de UI, erros e comentários em pt-BR. Identificadores em inglês. Imports com `@/`.
- Testes ao lado do código. `*.integration.test.ts` usa Postgres real.

## Review Focus

- Bureau indica a si mesmo, ou ciclo A->B->A: rejeitar.
- Toggle desligado: a seção some e a Server Action recusa, não só a UI.
- `walletId` sem formato válido ou vazio em modo `asaas`: recusar.
- Afiliado de link cadastrado pelo dono do bureau não pode ver nem editar afiliado de outro bureau (RLS).
- Trocar de modo vale só para cobranças criadas depois.

---

### Task 1: Indicação entre bureaus (superadmin)

**Files:**
- Create: `src/lib/bureaus/referrals.ts`, `src/app/(superadmin)/superadmin/bureaus/[id]/referral-actions.ts`
- Modify: `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx`, `src/lib/validators/` (schema novo)
- Test: `src/lib/bureaus/referrals.integration.test.ts`

**Depends-on:** Parte 1, Task 1. **Agente:** `backend-specialist` (sonnet).

**Interfaces:**
- Produces: `setBureauReferrer(ctx, { referredBureauId, referrerBureauId, pct }): Promise<{ ok: true } | { ok: false; reason: "self" | "cycle" | "already_referred" }>` e `clearBureauReferrer(ctx, { referredBureauId })`. Permissão `bureau_referral:manage` só para `superadmin`. Auditoria em cada mudança. `pct` padrão 5.
- UI: cartão "Bureau indicador" na página do bureau, com seleção do indicador e `pct`.

- [ ] **Step 1:** Testes: `self`, `cycle` e `already_referred` retornam `ok: false`; `bureau_admin` não consegue chamar; auditoria gravada; RLS isola bureaus.
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Implementar queries, Server Actions e o cartão.
- [ ] **Step 4:** Testes passam.
- [ ] **Step 5:** Commit `feat(bureaus): indicação entre bureaus gerenciada pelo superadmin`.

### Task 2: Configurar pagamentos (cards e lojas de app)

**Files:**
- Create: `src/components/affiliates/PayoutMethodCards.tsx`, `src/lib/affiliates/payout-settings.ts`, `src/lib/affiliates/store-links.ts`, `src/app/(portal)/portal/afiliacao/pagamentos/page.tsx`
- Modify: `src/app/(portal)/portal/afiliacao/page.tsx`, `src/app/(dashboard)/afiliados/` (cadastro do `walletId` pelo dono do bureau, em nome do afiliado)
- Test: `src/lib/affiliates/payout-settings.integration.test.ts`, teste do componente

**Depends-on:** Parte 1, Task 1. **Agente:** `backend-specialist` para `payout-settings.ts`; `frontend-specialist` para os componentes (sonnet). Skills: `/ui-ux-pro-max`, `/vercel:shadcn`.

**Interfaces:**
- Produces: `setPayoutMethod(ctx, { owner, method: PayoutMethod, asaasWalletId?: string }): Promise<{ error: string | null }>`. `walletId` obrigatório em `asaas`, formato validado por zod. Pode ser chamado pelo próprio afiliado, pelo `bureau_admin` do bureau dele ou pelo `superadmin`. `store-links.ts` exporta `ASAAS_APP_STORE_LINKS = { android: string; ios: string }` (o executor confirma os URLs oficiais).
- UI: botão "Configurar pagamentos" abre dois cards. **Conta Asaas:** recebe na hora, a cada pagamento do cliente; a taxa do Asaas já vem descontada; botões Play Store e App Store; campo `walletId` com ID mascarado para confirmar. **Chave Pix:** sem conta Asaas, o valor vira saldo na confirmação do pagamento, com a carência configurada (padrão 0 dia), saque por Pix. O mesmo componente serve ao afiliado de link e ao bureau indicador (na tela de configurações do bureau).

- [ ] **Step 1:** Testes: `asaas` sem `walletId` falha; `walletId` inválido falha; troca de modo grava auditoria sem expor o `walletId`; dono do bureau cadastra o `walletId` do afiliado dele e não o de outro bureau.
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Implementar queries, Server Action e componentes. Textos em pt-BR, acessíveis por teclado.
- [ ] **Step 4:** Testes passam. Conferir no navegador com Playwright MCP (um fluxo por modo).
- [ ] **Step 5:** Commit `feat(afiliados): tela de configurar pagamentos com Asaas ou Pix`.

### Task 3: Interruptor do afiliado e sub-afiliados do bureau

**Files:**
- Create: `src/lib/affiliates/enabled.ts`
- Modify: `src/app/(dashboard)/afiliados/` (controle de ligar/desligar e cadastro de afiliados do bureau), `src/app/(portal)/portal/afiliacao/` (`page.tsx`, `saque/`), `src/components/portal/nav-items.ts`, card na home do portal
- Test: `src/lib/affiliates/enabled.integration.test.ts`

**Depends-on:** Task 2 (mesmos arquivos do portal). **Agente:** `backend-specialist` (sonnet).

**Interfaces:**
- Produces: `isAffiliateEnabled(bureauId: string): Promise<boolean>` e `setAffiliateEnabled(ctx, { enabled: boolean }): Promise<{ error: string | null }>` (permissão `affiliate_settings:manage`, só `bureau_admin` e `superadmin`).
- Regra: desligado (padrão) => `/portal/afiliacao*` responde `notFound()`, o item de menu e o card da home somem, e as Server Actions de saque e de configurar pagamentos recusam. `buildSplitPlan` ignora o afiliado de link desse bureau. Ligado, a seção fica sempre aberta para os clientes dele. O dono do bureau cadastra e gerencia os afiliados do bureau na tela de afiliados.

- [ ] **Step 1:** Testes: padrão `false`; com `false` as ações recusam e `buildSplitPlan` ignora o afiliado de link; `operator` não consegue ligar; ligar grava auditoria.
- [ ] **Step 2:** Rodar e ver falhar.
- [ ] **Step 3:** Implementar o controle e o bloqueio nas rotas, menu, home e ações.
- [ ] **Step 4:** Testes passam. `npm run check`.
- [ ] **Step 5:** Commit `feat(afiliados): seção de afiliado oculta até o bureau ligar`.

## Ordem de execução

Onda 1 (paralela): Task 1, Task 2. Onda 2: Task 3. Rodam a partir da conclusão da Task 1 da Parte 1. O coordenador faz os commits.
