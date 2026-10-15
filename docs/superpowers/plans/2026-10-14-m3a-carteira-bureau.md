# M3a — Carteira do Bureau e recarga PIX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute com `superpowers:subagent-driven-development` em **ondas** (`Files:` / `Depends-on:`, regra `.claude/rules/08-parallel-subagent-driven-development.md`). Os implementadores **não fazem commit**: deixam as mudanças na árvore e reportam `Files changed`. O controlador faz um commit por task, na ordem do plano. Sem reviewer por task. Steps usam checkbox (`- [ ]`).

**Goal:** Cada Bureau tem uma carteira pré-paga com livro-razão imutável. O admin do Bureau recarrega o saldo por PIX (Asaas). O M6 reserva, captura e libera saldo por funções prontas.

**Architecture:** Uma migration nova (`012_wallet.sql`) cria 4 tabelas, triggers, RLS e 2 funções SQL: `wallet_apply` (único caminho de escrita da carteira) e `apply_asaas_payment` (usada só pelo webhook). Camadas: Server Action → `src/lib/wallet/queries.ts` → função SQL. O Asaas fica atrás de um adaptador em `src/lib/asaas/`, com fake nos testes.

**Tech Stack:** Next.js 14.2, PostgreSQL 18.6 (RLS), node-postgres, zod, Vitest 4, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-14-m3a-carteira-bureau-design.md`. Base: M2 merged (branch `feature/m2-catalogo-precos`). As issues do M3a ainda não existem: crie-as antes do primeiro commit e use o número em `Closes #n`.

## Global Constraints

- Crie `db/migrations/012_wallet.sql`. Não edite as migrations 003–011. Recrie o banco de dev antes dos testes de integração: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Testes de integração (`*.integration.test.ts`) rodam contra `127.0.0.1:54329` e usam `src/test/seed.ts`.
- Passe a identidade (`DbIdentity`) inteira. Chame `hasPermission(subject, permission)` com o objeto.
- `bureau_id` de escrita vem da identidade. Exceção única: o `adjustment` do superadmin recebe o `bureau_id` alvo, validado por zod (uuid) e por `wallet:adjust`.
- Dinheiro: `numeric(15,2)`; em TypeScript, string decimal; compare e some em centavos inteiros; nunca `number` de ponto flutuante. Reuse `src/lib/catalog/money.ts`. Faixa de lançamento: `> 0` e `<= 99999999.99`.
- Auditoria no mesmo cliente da transação. Nunca CPF/CNPJ, chave de API, token nem payload PIX completo em `metadata` (o `redact` cobre chaves óbvias; não dependa só dele).
- Server Actions: zod `safeParse` → `getRequiredSession` → `hasPermission` → query → `revalidatePath`; retorno `{ error: string | null, id? }`. Queries retornam `{ ok: false, reason }` para conflito de negócio.
- Segredos só em variáveis de ambiente (`ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`). Nunca no repositório.
- Identificadores em inglês. UI, erros e comentários em pt-BR.
- **Gate da task:** os testes do escopo da task passam. `npm run lint && npm run type-check && npm run test` passam no fim da última onda.
- Implementadores: agente especialista com `model: "sonnet"`. Nunca `opus`.
- Commits: um por task, Conventional Commits, `Closes #n` no corpo quando a task fecha a issue, linha final `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Rode `git rev-parse --short HEAD` antes e registre o hash. `git add` só dos `Files:` da task.

## Decisões deste plano que completam a spec

1. **Pagamento depois do vencimento.** Pagamento recebido de uma cobrança `pending` ou `expired` credita o saldo. O dinheiro já entrou. Cobrança `cancelled` ou desconhecida: o evento é gravado e não credita.
2. **Estado `expired` derivado.** A coluna `status` fica `pending` até o pagamento. A query de leitura calcula o estado efetivo (`pending` com `expires_at < now()` vira `expired`). Sem job agendado.
3. **Auditoria do webhook.** O webhook não tem usuário. `apply_asaas_payment` grava o `topup` e o evento de auditoria com `user_id = pix_charges.requested_by` e `metadata.source = 'asaas_webhook'`.
4. **Quem reserva.** `reserve`, `capture` e `release` aceitam qualquer identidade cujo `app_bureau_id()` é o Bureau da carteira. O M6 restringe por papel quando ligar o pedido.
5. **Auditoria do ajuste do superadmin.** O superadmin fora de suporte não tem Bureau no contexto. A Task 1 estende a política `audit_logs_insert` (modelo da migration 011) para a ação `wallet.adjust`, exigindo um lançamento `adjustment` do mesmo autor e Bureau na mesma transação.

## Review Focus

1. Duas reservas concorrentes somam mais que o saldo — Task 1: `concurrent reserves never overdraw`.
2. Webhook informa valor diferente do cobrado — Task 3: `credits the stored amount, not the payload amount`.
3. Webhook entregue duas vezes ao mesmo tempo — Task 3: `parallel duplicate events credit once`.
4. Pagamento chega depois dos 30 minutos — Task 3: `paid after expiry still credits`.
5. Mesma `idempotency_key` com valor ou tipo diferente — Task 2: `idempotency key reuse with different amount is rejected`.

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `db/migrations/012_wallet.sql` | tabelas, triggers, RLS, `wallet_apply`, `apply_asaas_payment`, política de auditoria | 1 |
| `src/test/seed.ts` | helper de carteira e cobrança PIX (acrescenta, não muda o existente) | 1 |
| `src/lib/wallet/wallet.integration.test.ts` | isolamento, imutabilidade, concorrência, conciliação | 1 |
| `src/lib/db/permissions.ts` | permissões `wallet:read`, `wallet:topup`, `wallet:adjust` | 2 |
| `src/lib/wallet/queries.ts` e testes | `reserve`, `capture`, `release`, `adjust`, `getWallet`, `listLedger` | 2 |
| `src/lib/validators/wallet.ts` | schemas zod | 2 |
| `src/actions/wallet.ts` e teste | `adjustWalletAction` | 2 |
| `src/lib/asaas/{types,client,fake,index}.ts` e testes | adaptador Asaas, fake, seleção por configuração | 3 |
| `src/lib/config.ts` e `.env.example` | variáveis `ASAAS_*` | 3 |
| `src/lib/wallet/pix-charges.ts` e teste | criar cobrança, ler estado efetivo | 3 |
| `src/actions/wallet-topup.ts` e teste | `requestTopupAction` | 3 |
| `src/app/api/webhooks/asaas/route.ts` e teste | webhook | 3 |
| `src/middleware.ts` | rota do webhook pública | 3 |
| `src/app/(dashboard)/settings/wallet/`, `src/components/wallet/`, `src/components/layout/Sidebar.tsx` | tela do Bureau | 4 |
| `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx`, `src/components/superadmin/WalletAdjustForm.tsx` | seção Carteira do superadmin | 4 |

**Arquivos compartilhados e dono único:** `src/lib/db/permissions.ts` → Task 2. `src/lib/config.ts` e `src/middleware.ts` → Task 3. `src/components/layout/Sidebar.tsx` → Task 4.

## Ondas

| Onda | Tasks | Por quê |
|---|---|---|
| 1 | 1 | schema, RLS e funções são a base |
| 2 | 2 | usa as tabelas e `wallet_apply` |
| 3 | 3 | usa `apply_asaas_payment` (Task 1) e as permissões (Task 2) |
| 4 | 4 | consome as Tasks 2 e 3 |

Review uma vez, no fim, sobre o diff inteiro do M3a: `code-reviewer` e `security-reviewer` (dinheiro, webhook público, RLS). Um `opus` pode fazer o review final por tocar dinheiro e segurança; nunca como implementador.

---

### Task 1: Migration, RLS e funções da carteira

**Agent:** `database-architect` · `model: "sonnet"`
**Files:**
- Create: `db/migrations/012_wallet.sql`
- Create: `src/lib/wallet/wallet.integration.test.ts`
- Modify: `src/test/seed.ts` (acrescenta helpers)

**Depends-on:** none

**Contrato do schema** (spec, itens 1–5, 8, 10, 12):
- `wallets(bureau_id pk, available numeric(15,2), reserved numeric(15,2))`, CHECK `>= 0`. A migration cria a linha da carteira junto com cada Bureau (trigger ou backfill dos Bureaus existentes).
- `ledger_entries(id, bureau_id, kind, amount, available_after, reserved_after, idempotency_key, reference, reason, created_by, created_at)`. `kind` em `topup | reserve | capture | release | adjustment`. `unique (bureau_id, idempotency_key)`. Trigger bloqueia UPDATE e DELETE, também para o dono da tabela.
- `pix_charges(id, bureau_id, asaas_payment_id unique, amount, status, pix_payload, expires_at, requested_by, created_at)`. `status` em `pending | paid | expired | cancelled`. CHECK de valor `>= 10.00 and <= 5000.00`.
- `asaas_webhook_events(id, event_id unique, event_type, asaas_payment_id, payload jsonb, result, received_at)`.
- FK composta para `bureaus`, `bureau_id not null` e política de tenant do M1 nas quatro tabelas.

**Contrato das funções:**
- `wallet_apply(p_bureau_id uuid, p_kind text, p_amount numeric, p_idempotency_key text, p_reference text, p_reason text)` devolve `(ok boolean, reason text, entry_id uuid, available numeric, reserved numeric, replayed boolean)`.
  - Efeito por tipo: `reserve` move `available` → `reserved`; `capture` baixa `reserved`; `release` move `reserved` → `available`; `adjustment` soma ou subtrai `available` (valor com sinal).
  - Razões de falha: `insufficient_balance`, `reservation_exceeded`, `idempotency_conflict`, `reason_required` (ajuste sem motivo), `not_allowed`.
  - Autorização dentro da função: `topup` não é aceito (só `apply_asaas_payment` o cria). `adjustment` exige `app_user_role() = 'superadmin'`. Os demais exigem `app_bureau_id() = p_bureau_id`.
  - Mesma chave com mesmo tipo e valor devolve o lançamento original com `replayed = true` e não altera o saldo. Mesma chave com tipo ou valor diferente devolve `idempotency_conflict`.
- `apply_asaas_payment(p_event_id text, p_event_type text, p_asaas_payment_id text, p_payload jsonb)` devolve `result text` em `credited | duplicate | ignored | unknown_charge`. `SECURITY DEFINER`, `grant execute` à role de runtime. Grava o evento bruto; se for novo e a cobrança estiver `pending` ou `expired`, marca `paid`, cria o `topup` com o valor de `pix_charges.amount` e grava a auditoria (decisões 1 e 3 acima). `revoke all … from public`.
- A role de runtime não tem INSERT/UPDATE direto em `wallets` nem `ledger_entries`.

**Forma exata do bloqueio** (a ordem é o requisito):
```sql
select available, reserved from wallets where bureau_id = p_bureau_id for update;
-- valida, calcula, depois:
insert into ledger_entries (...) values (...);
update wallets set available = v_available_after, reserved = v_reserved_after where bureau_id = p_bureau_id;
```

**RLS e auditoria:**
- Tenant lê e insere apenas o próprio Bureau (modelo do M1).
- Exceção de leitura: o superadmin sem suporte lê `wallets` e `ledger_entries` de qualquer Bureau. Nenhuma outra tabela de tenant ganha a exceção.
- Recrie `audit_logs_insert` (modelo da migration 011) com o ramo extra da decisão 5. Recrie também a política de leitura equivalente para `wallet.adjust`. Preserve o ramo `catalog.cost.set` sem mudança.

**Testes (casos mínimos):**
- Cada tipo move `available` e `reserved` como no contrato.
- `concurrent reserves never overdraw`: duas transações reservam, juntas, mais que o saldo; só uma passa.
- `reserve` sem saldo → `insufficient_balance`; `capture` e `release` acima do reservado → `reservation_exceeded`.
- Idempotência: repetição devolve `replayed = true` sem mudar o saldo; chave igual com valor diferente → `idempotency_conflict`.
- UPDATE e DELETE em `ledger_entries` falham via role da aplicação e via dono.
- `topup` direto por `wallet_apply` → `not_allowed`; `adjustment` por `bureau_admin` → `not_allowed`; sem motivo → `reason_required`.
- Conciliação: a soma dos lançamentos de um Bureau é igual a `available + reserved` (considerando o sinal de cada tipo).
- Isolamento: admin do Bureau A não lê nem escreve a carteira, o extrato ou as cobranças do Bureau B.
- Superadmin sem suporte lê `wallets` e `ledger_entries`, e lê zero linhas de `holders`, `bureau_catalog_items` e das demais tabelas de tenant.
- `apply_asaas_payment`: pendente credita; repetido → `duplicate` sem novo crédito; desconhecido → `unknown_charge`; `cancelled` → `ignored`; `expired` credita.
- Auditoria do ajuste do superadmin passa; a mesma ação sem lançamento `adjustment` na transação falha.

- [ ] Escreva os testes (vermelhos).
- [ ] Escreva a migration e rode `npm run db:reset` com a URL do dono.
- [ ] Rode `npx vitest run src/lib/wallet/wallet.integration.test.ts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 2: Serviço da carteira, permissões e ajuste do superadmin

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/wallet/queries.ts`, `src/lib/wallet/queries.integration.test.ts`
- Create: `src/lib/validators/wallet.ts`
- Create: `src/actions/wallet.ts`, `src/actions/wallet.test.ts`
- Modify: `src/lib/db/permissions.ts`

**Depends-on:** 1

**Contrato:**
- Permissões (spec, item 11): `superadmin` → `wallet:read`, `wallet:adjust`. `bureau_admin` → `wallet:read`, `wallet:topup`. `operator` → `wallet:read`. `client` → nenhuma. Superadmin em suporte herda as permissões do operator pela regra existente.
- `queries.ts` exporta, todas recebendo o `PoolClient` da transação:
  - `reserve(client, { bureauId, amount, idempotencyKey, reference })`, `capture(...)`, `release(...)` → `{ ok: true, entryId, available, reserved, replayed } | { ok: false, reason }`.
  - `adjust(client, { bureauId, amount, reason, idempotencyKey })` com `amount` string decimal com sinal.
  - `getWallet(client, bureauId)` → `{ available, reserved }` como strings decimais.
  - `listLedger(client, bureauId, { limit, cursor })` → página por keyset `(created_at, id)`, `limit` máximo 100.
  - Cada função chama `wallet_apply` e traduz o resultado; nenhuma regra de saldo vive em TypeScript.
- `adjustWalletAction({ bureauId, amount, reason })`: zod (uuid, valor decimal com sinal em centavos, `reason` 1–500 caracteres) → `wallet:adjust` → `adjust` → auditoria `wallet.adjust` com `bureauId` explícito e `metadata` com valor, motivo e saldo depois → `revalidatePath`. A chave de idempotência é gerada no formulário (uuid) e enviada pelo cliente.
- Nenhum `number` de ponto flutuante em valores; use `src/lib/catalog/money.ts`.

**Testes (casos mínimos):**
- Cada permissão por papel, incluindo superadmin em suporte e `client`.
- `idempotency key reuse with different amount is rejected` (via query).
- Ação: zod rejeita valor zero, valor com mais de 2 casas, motivo vazio e `bureauId` inválido.
- Ação: `bureau_admin` e `operator` recebem erro de permissão; superadmin ajusta e a auditoria sai com o `bureau_id` alvo.
- `listLedger`: ordem, `limit` máximo e cursor sem repetir linhas.
- Soma em centavos: `0.10 + 0.20` dá `0.30`.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/wallet src/actions/wallet.test.ts src/lib/db` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 3: Adaptador Asaas, recarga PIX e webhook

**Agent:** `backend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/lib/asaas/{types,client,fake,index}.ts`, `src/lib/asaas/asaas.test.ts`
- Create: `src/lib/wallet/pix-charges.ts`, `src/lib/wallet/pix-charges.integration.test.ts`
- Create: `src/actions/wallet-topup.ts`, `src/actions/wallet-topup.test.ts`
- Create: `src/app/api/webhooks/asaas/route.ts`, `src/app/api/webhooks/asaas/route.test.ts`
- Modify: `src/lib/config.ts`, `src/lib/config.test.ts`, `.env.example`, `src/middleware.ts`

**Depends-on:** 1, 2

**Contrato:**
- Configuração (`src/lib/config.ts`, mesmo estilo de `required`/`url`): `ASAAS_DRIVER` em `asaas | fake`; com `asaas`, exige `ASAAS_API_KEY`, `ASAAS_API_BASE_URL` (URL válida) e `ASAAS_WEBHOOK_TOKEN`. `fake` é rejeitado quando `NODE_ENV=production`. Sem driver configurado: erro claro, sem fallback silencioso. Atualize `.env.example` sem valores reais.
- Adaptador (`index.ts` escolhe pela configuração):
  - `createPixCharge({ amount, externalReference, description })` → `{ asaasPaymentId, pixPayload, qrImageBase64 }`.
  - Implementação real chama a API do Asaas (cobrança PIX e QR). Confira a documentação vigente do Asaas antes de fixar caminhos, nomes de evento e o header do token. Registre o que conferiu num comentário curto no `client.ts`.
  - O fake devolve ids determinísticos e permite simular o evento de pagamento nos testes.
  - O `asaasPaymentId` não deve vazar para o navegador.
- `pix-charges.ts`: `createPixCharge(client, identity, amount)` insere em `pix_charges` com `expires_at = now() + 30 min`, valida faixa R$ 10,00–R$ 5.000,00 em centavos, grava auditoria `wallet.topup.request`; `getPixCharge(client, id)` e `listPixCharges(client, bureauId)` devolvem o estado efetivo (decisão 2).
- `requestTopupAction({ amount })`: zod → `wallet:topup` → chama o adaptador → grava a cobrança → devolve `{ error, id? }` com o necessário para o QR. Falha do Asaas não deixa linha `pending` órfã (grave a cobrança só depois da resposta do Asaas, ou desfaça).
- Webhook `POST /api/webhooks/asaas`:
  1. Compare o header de token com `ASAAS_WEBHOOK_TOKEN` em tempo constante (`crypto.timingSafeEqual` com tamanhos iguais). Falha → 401 e nada é gravado.
  2. Valide o corpo com zod (id do evento, tipo, id do pagamento). Corpo inválido → 400.
  3. Eventos de pagamento recebido/confirmado chamam `apply_asaas_payment`; os demais são gravados e respondem 200 sem crédito.
  4. Resposta 200 para `credited`, `duplicate`, `ignored` e `unknown_charge`. Erro de banco → 500 (o Asaas reenvia).
  5. O valor creditado nunca vem do corpo.
- `src/middleware.ts`: adicione `/api/webhooks/asaas` aos caminhos públicos. A rota não usa sessão.

**Testes (casos mínimos):**
- Config: `fake` em produção falha; `asaas` sem chave falha; sem driver falha.
- Cobrança abaixo de R$ 10,00 ou acima de R$ 5.000,00 é rejeitada; valor com 3 casas é rejeitado.
- `bureau_admin` solicita; `operator` e `client` recebem erro; falha do adaptador não deixa linha pendente.
- Webhook: token ausente ou errado → 401 e zero linhas em `asaas_webhook_events`; corpo inválido → 400.
- `credits the stored amount, not the payload amount`.
- `parallel duplicate events credit once` (duas chamadas simultâneas, mesmo `event_id`).
- `paid after expiry still credits`.
- Cobrança `cancelled` e pagamento desconhecido: 200 e sem crédito.
- O estado efetivo de uma cobrança `pending` vencida é `expired`.

- [ ] Escreva os testes (vermelhos), implemente, rode `npx vitest run src/lib/asaas src/lib/wallet src/actions/wallet-topup.test.ts src/app/api/webhooks src/lib/config.test.ts` até ficar verde.
- [ ] Entregue: lista de `Files changed`.

---

### Task 4: Telas da carteira

**Agent:** `frontend-specialist` · `model: "sonnet"`
**Files:**
- Create: `src/app/(dashboard)/settings/wallet/page.tsx`
- Create: `src/components/wallet/{WalletBalance,TopupDialog,LedgerTable}.tsx`
- Create: `src/components/superadmin/WalletAdjustForm.tsx`
- Modify: `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx`
- Modify: `src/components/layout/Sidebar.tsx`

**Depends-on:** 2, 3

**Contrato:**
- Invoque `/vercel:nextjs`, `/vercel:shadcn` e `/ui-ux-pro-max` antes de escrever UI. Use os componentes de `src/components/ui/` e siga o estilo de `src/components/settings/CatalogForm.tsx`.
- `/settings/wallet`: `wallet:read` abre a página. Mostra saldo disponível e reservado (formato BRL, helper `formatBRL`), botão "Recarregar" só com `wallet:topup`, e o extrato paginado por cursor ("Carregar mais"). O operador vê tudo, menos o botão.
- `TopupDialog` (client component): campo de valor (mínimo R$ 10,00, máximo R$ 5.000,00, entrada decimal com vírgula como em `money-input`), chama `requestTopupAction`, mostra QR e código copia-e-cola, e chama `router.refresh()` a cada 5 s enquanto a cobrança estiver `pending`. Mostra "Pago", "Expirado" ou "Cancelado" conforme o estado efetivo.
- `/superadmin/bureaus/[id]`: seção "Carteira" com saldo, extrato e `WalletAdjustForm` (valor com sinal, motivo obrigatório, chave de idempotência uuid gerada no formulário).
- Sidebar: link "Carteira" para `wallet:read`, com ícone da família já usada. Mantenha a regra de item ativo do arquivo (cuide de `/settings/wallet` vs `/settings`).
- Textos em pt-BR. Estados de erro e carregamento visíveis; foco e rótulos acessíveis no diálogo.

**Testes:** UI de apresentação não leva teste. Teste só a lógica com ramo: parse da entrada de valor do `TopupDialog` e a decisão "mostra botão Recarregar" por permissão, se extraídas em função pura. Verificação visual: `npm run dev`, entre como `bureau_admin` e como `operator` e confira a página com o driver `fake`.

- [ ] Implemente, rode `npm run lint && npm run type-check` e os testes das funções extraídas.
- [ ] Verifique as duas telas no navegador com `ASAAS_DRIVER=fake`.
- [ ] Entregue: lista de `Files changed`.

---

## Critérios de pronto

Cada critério aponta para o teste que o prova (lista da spec).

- `reserve`, `capture` e `release` movem os saldos (Task 1, 2).
- Saldo nunca negativo, nem sob concorrência (Task 1).
- `idempotency_key` repetida não altera o saldo (Task 1, 2).
- UPDATE e DELETE em `ledger_entries` falham (Task 1).
- Soma dos lançamentos igual ao saldo (Task 1).
- Isolamento entre Bureaus (Task 1).
- Webhook: token inválido, repetição, valor local, mínimo e máximo (Task 3).
- `adjustment` sem motivo rejeitado; só o superadmin ajusta (Task 1, 2).
- `/settings/wallet` mostra saldo, QR e extrato; o operador não vê "Recarregar" (Task 4, verificação visual).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da onda 4.
- (post-deploy) Valide o contrato real do Asaas (criação de cobrança PIX, QR, nome do evento, header do token) com uma cobrança de valor mínimo na conta real. Registre como item "Post-deploy follow-up" no PR. Não bloqueia o merge.

## Cobertura da spec

| Spec | Task |
|---|---|
| Itens 1–7 (tabelas, ledger, saldo, idempotência, dinheiro) | 1, 2 |
| Item 8 (recarga PIX, faixa, expiração) | 1, 3 |
| Item 9 (adaptador Asaas) | 3 |
| Item 10 (webhook) | 1, 3 |
| Item 11 (permissões) | 2 |
| Item 12 (acesso ao banco) | 1 |
| Item 13 (auditoria) | 1, 2, 3 |
| Item 14 (segredos) | 3 |
| Telas | 4 |
