# Cupons de desconto do Bureau — plano de implementação

> **Para agentes:** use `superpowers:subagent-driven-development` com as ondas paralelas de `.claude/rules/08-parallel-subagent-driven-development.md`. Implementadores não fazem commit; o coordenador comita por tarefa, só depois que o usuário autorizar.

**Meta:** o Bureau cria cupons e o cliente os usa ao abrir uma pesquisa no portal, com o preço final decidido no banco.

**Arquitetura:** o desconto fica gravado em `order_settlements` e é calculado em `reserve_order` (SQL). O Bureau cobre a falta (`custo − preço pago`) com a carteira pré-paga e depois com o valor a repassar liberado. A tela só mostra uma prévia.

**Stack:** Next.js 14 (App Router), TypeScript, zod, `pg` com SQL cru, PostgreSQL com RLS, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-19-cupons-desconto-design.md` (aprovada). Cada tarefa lê a spec; o plano não repete as regras.

## Restrições globais

- Migrações novas: `048_coupons.sql`, `049_coupon_money.sql`. Nunca editar migração aplicada. Funções `security definer` com `set search_path = pg_catalog, public`.
- Todo acesso a dados em `withUserTransaction`. Nenhum `PoolClient` sai do módulo de queries. SQL parametrizado.
- Server Action: zod `safeParse`, sessão, `hasPermission(role, "coupons:read|write")`, consulta, `revalidatePath`. Retorno `{ error: string | null, id? }`.
- Auditoria na mesma transação: `coupon.create`, `coupon.update`, `coupon.deactivate`, `coupon.redeem`, `coupon.release`. Rótulos em `src/lib/audit/labels.ts`. Nenhum CPF/CNPJ completo em log ou auditoria.
- Textos de UI, erros e comentários em pt-BR. Identificadores em inglês. Importar com `@/`.
- Valores em centavos no TypeScript e `numeric(15,2)` no banco.
- Mensagem única ao cliente para cupom inexistente, vencido, de outro Bureau ou fora do escopo: "Cupom inválido ou indisponível".

## Foco da revisão (casos que as tarefas testam)

1. Dois pedidos disputam o último uso do mesmo cupom: só um passa (T2).
2. Fixo maior que a base, ou 100%: preço pago 0, sem reserva do cliente, sem NFS-e (T2, T5).
3. Pedido com cupom que falha, é cancelado ou expira: uso, carteira e repasse voltam (T2).
4. Repasse (`create_payout`) e reserva com cupom ao mesmo tempo: o mesmo dinheiro não é gasto duas vezes (T2).
5. Código com espaços ou minúsculas (` demo `) vale como `DEMO`; cupom de outro Bureau dá a mensagem única (T1, T4).

## Ondas

| Onda | Tarefas |
|---|---|
| 1 | T1 |
| 2 | T2, T4 |
| 3 | T3, T5, T6 |
| 4 | T7 |
| 5 | T8 |

---

### Task 1: Esquema, RLS e tipos de repasse
**Agente:** `database-architect`, `sonnet`. **Depends-on:** none.
**Files:** `db/migrations/048_coupons.sql`, `src/lib/db/rls.integration.test.ts`.
**Faz:** tabelas `coupons`, `coupon_products`, `coupon_redemptions` e colunas `coupon_id`, `discount` em `order_settlements`, como na spec ("Modelo de dados"). Relaxa os checks de `order_settlements` só com `coupon_id`. Trigger de transição única em `coupon_redemptions`. Tipos `coupon_cost` e `coupon_refund` em `bureau_payable_entries`. Atualiza `payable_buckets` e `create_payout` para contá-los. Código normalizado (`btrim` + `upper`) e único por Bureau.
**Contrato produzido:** tabelas e colunas acima; permissões `coupons:read` e `coupons:write` (localizar o mapa de papéis usado por `hasPermission` e acrescentar para o admin do Bureau).
**Testes:** caso de RLS por tabela nova (outro Bureau não lê nem escreve; cliente não lê `coupons`); `order_settlements` aceita `price = 0` com cupom e recusa sem cupom; `coupon_redemptions` recusa qualquer UPDATE fora de `reserved` → `consumed|released`.

### Task 2: Dinheiro no SQL: reserva, captura, liberação
**Agente:** `database-architect`, `sonnet`. **Depends-on:** T1.
**Files:** `db/migrations/049_coupon_money.sql`, `src/lib/settlement/coupons.integration.test.ts`.
**Faz:** redefine `reserve_order(p_order_ref, p_mode, p_client_profile_id, p_price, p_cost, p_quote, p_coupon_code text default null)`. Com cupom: trava a linha do cupom (`for update`), valida as regras da spec, calcula o desconto uma vez sobre as linhas aceitas, compara o preço pago com `p_price` (`price_mismatch`), calcula `falta`, trava `payout:<bureau>` (mesmo advisory lock de `create_payout`), reserva a carteira do Bureau (`reserve`, chave `coupon:<order_ref>:wallet`) e lança `coupon_cost` do restante, grava a redenção `reserved` e a auditoria `coupon.redeem`. Preço pago 0: sem reserva na carteira do cliente. Redefine `capture_order` (redenção `consumed`, captura da carteira do Bureau, sem acréscimo se margem ≤ 0, pula a captura do cliente se pago 0) e `release_order` (redenção `released`, `release` da carteira, `coupon_refund`, auditoria `coupon.release`). Lista todo caminho que fecha pedido sem `release_order` (cancelamento do cliente em 025, expiração, `runOrdersTick`) e faz cada um devolver a redenção.
**Contrato produzido:** motivos de retorno `coupon_invalid`, `coupon_expired`, `coupon_exhausted`, `coupon_client_limit`, `coupon_product_not_allowed`, `coupon_funds_insufficient`. Sem cupom, o comportamento atual não muda.
**Testes** (Postgres real): percentual, fixo, 100% sem saldo do cliente, trunfo e produto específico, limite total, limite por cliente, validade, duas reservas simultâneas no último uso, falta só na carteira, falta carteira + repasse, recusa sem fundos, liberação por falha, por cancelamento e por expiração devolve tudo, reembolso pós-captura não desfaz `coupon_cost`, comissão de afiliado com margem 0, repasse simultâneo.

### Task 3: Camada TypeScript de pedido
**Agente:** `backend-specialist`, `sonnet`. **Depends-on:** T2.
**Files:** `src/lib/coupons/discount.ts`, `src/lib/coupons/discount.test.ts`, `src/lib/settlement/queries.ts`, `src/lib/orders/queries.ts`, `src/actions/orders-client.ts` (e o teste de unidade correspondente).
**Contrato produzido:** `computeCouponDiscount(input: { kind: "percent" | "fixed"; value: number; eligibleTotalCents: number }): { discountCents: number; paidCents: number }` (arredonda uma vez; pago nunca negativo). `reserveOrder` e `placeOrder` aceitam `couponCode?: string` e repassam o preço pago. `openClientOrderAction` recebe `couponCode` opcional e traduz os motivos de T2 para a mensagem única ou para mensagens específicas só quando não revelam existência de cupom (fundos insuficientes do Bureau mostra "Cupom indisponível no momento").
**Testes:** unidade do cálculo (percentual com arredondamento, fixo maior que a base, 100%, base 0); ação rejeita código inválido com a mensagem única.

### Task 4: CRUD de cupons e prévia (dados e ações)
**Agente:** `backend-specialist`, `sonnet`. **Depends-on:** T1.
**Files:** `src/lib/validators/coupons.ts`, `src/lib/coupons/queries.ts`, `src/lib/coupons/queries.integration.test.ts`, `src/actions/coupons.ts`, `src/lib/audit/labels.ts`.
**Contrato produzido:** `createCouponAction`, `updateCouponAction`, `setCouponActiveAction` (admin do Bureau, `coupons:write`); `listCoupons(bureauId)` com usos/limite; `previewCouponAction({ productCode, partners, couponCode })` → `{ listCents, discountCents, paidCents } | { error }`, sem consumir nada. Normaliza o código (`btrim` + `upper`, 3–32 caracteres `A-Z0-9_-`). Limite de tentativas da prévia: reaproveitar o limitador de taxa do projeto, se existir (verificar com `graphify query`).
**Testes:** validação zod (percentual de 0,01 a 100, fixo maior que 0, `valid_until` depois de `valid_from`); outro Bureau não vê nem altera cupom; auditoria gravada; prévia não cria redenção.

### Task 5: NFS-e: sem nota com preço pago 0
**Agente:** `backend-specialist`, `sonnet`. **Depends-on:** T2.
**Files:** o ponto de disparo da emissão (localizar em `src/lib/nfse/` e `docs/operations/`), mais o teste.
**Faz:** acrescenta a guarda `preço pago > 0`; com cupom e pago > 0 a nota usa o valor pago.
**Testes:** pedido com cupom 100% não gera tarefa de emissão; pedido com cupom parcial gera nota pelo valor pago.

### Task 6: Tela de cupons do Bureau
**Agente:** `frontend-specialist`, `sonnet`. **Depends-on:** T4.
**Skills antes de começar:** `/ui-ux-pro-max`, `/vercel:shadcn`.
**Files:** `src/app/(dashboard)/settings/cupons/page.tsx`, `src/components/settings/coupons/*`, link no menu de configurações.
**Faz:** lista (código, tipo e valor, produtos, usos/limite, validade, ativo), criar, editar e desativar, seguindo `settings/catalog`. Estados vazio, carregando e erro. Acessível por teclado.
**Testes:** só o formulário (validação e estados); sem teste de layout.

### Task 7: Campo de cupom no portal
**Agente:** `frontend-specialist`, `sonnet`. **Depends-on:** T3, T4.
**Files:** `src/app/(portal)/portal/pesquisas/nova/page.tsx` e o componente do formulário de pesquisa.
**Faz:** campo "Cupom" com botão "Aplicar" que chama `previewCouponAction` e mostra preço de tabela, desconto e total. O envio leva `couponCode`. Limpar o cupom volta ao preço de tabela. Mensagem de erro sempre a retornada pela ação.
**Testes:** estados do campo (vazio, aplicado, erro, removido).

### Task 8: Documentação
**Agente:** `documentation-writer`, `haiku`. **Depends-on:** T1–T7.
**Files:** `docs/architecture.md` (migrações 048 e 049, fluxo do dinheiro com cupom), `PRODUCT.md` (cupons no escopo), `docs/operations/` (nota sobre NFS-e e pedidos de preço 0).
**Faz:** atualiza só o que mudou, sem duplicar a spec.

---

## Fecho

Gate de cada tarefa: testes do escopo passam (2 tentativas do mesmo especialista, depois escalar). No fim: `npm run check`, uma revisão `/code-review` com `code-reviewer` e `security-reviewer` (dinheiro e RLS), e o PR com `Closes #n`. Sem item pós-deploy.
