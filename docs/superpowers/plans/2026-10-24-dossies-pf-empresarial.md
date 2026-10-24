# Dossiê Pessoa Física e Dossiê Empresarial Estruturado — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project override: waves and review rules in `.claude/rules/08-parallel-subagent-driven-development.md` and "Lean delivery" in `CLAUDE.md` (no per-task reviewer; implementers do not commit; the coordinator commits one conventional commit per task).

**Goal:** Trocar o catálogo por 2 produtos (Dossiê Pessoa Física e Dossiê Empresarial Estruturado) com parecer IA embutido e preço `base + por_sócio × n`, e abrir o Dossiê Empresarial no portal com aceite por sócio, acompanhamento, cancelamento com estorno e declaração do comprador.

**Architecture:** As regras de dinheiro e de pedido continuam no PL/pgSQL (`resolve_product_terms`, `open_order`, `reserve_order`). O banco recalcula o total pelo número de sócios gravado no pedido. As funções novas do cliente (cancelar, listar membros, gravar declaração) ficam numa migration nova `025`. TypeScript só valida, cota para a tela e chama as funções.

**Tech Stack:** Next.js 14 App Router, Server Actions, zod, `pg` sem ORM, PostgreSQL 18 com RLS, Vitest (unit e integração com Postgres em `127.0.0.1:54329`), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-dossies-pf-empresarial-design.md`

## Global Constraints

- Base de migrations editável (sem produção): edite `010`, `022` no lugar e crie `025`. Depois de cada mudança de SQL: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Códigos novos: `dossie_pf` (DEPS "Smart PF 002") e `dossie_empresarial` (DEPS "Smart PJ 010"; cada sócio usa o `deps_product` de `dossie_pf`). Nomes exibidos: "Dossiê Pessoa Física" e "Dossiê Empresarial Estruturado".
- Saem por completo: `consulta_pf`, `consulta_pj`, `dossie_pj_completo`, `parecer_ia`, `products.kind`, `products.addon_for`, `dossier_orders.with_ai`, `AI_ADDON_CODE`, campos `withAi`. Remova os órfãos que a mudança criar.
- Dinheiro `numeric(15,2)` no banco; centavos inteiros no TS (`toCents`/`fromCents` de `src/lib/catalog/money.ts`). Venda: `base > 0`, `por_sócio >= 0`. Custo: os dois `>= 0`. Regra por campo: venda ≥ custo em cada campo.
- Sócio: só CPF (11 dígitos), de 0 a 20 (`MAX_PARTNERS = 20`), contado uma vez por documento; sócio com o documento da empresa é inválido.
- Padrões do `AGENTS.md`: zod `safeParse` → sessão → `hasPermission` → query → `revalidatePath`; `withUserTransaction`; `{ ok: false, reason }`; auditoria na mesma transação; textos em pt-BR; nunca CPF/CNPJ completo em log ou auditoria.
- Toda tabela nova com RLS (`enable` + `force`) e caso em `src/lib/db/rls.integration.test.ts`.
- Implementers: agente especialista com `model: sonnet`. Gate de cada tarefa: os testes da própria tarefa verdes (2 tentativas, depois escalar).

## Review Focus

1. **Sócio repetido ou igual à empresa**: o mesmo CPF duas vezes cobra uma vez; CPF igual ao CNPJ da empresa é `invalid_input`. Teste na Tarefa 3.
2. **Preço muda entre a tela e a confirmação** (o Bureau edita o catálogo no meio): `reserve_order` recusa com `price_mismatch` e a action mostra "O preço mudou. Revise e confirme de novo." Testes nas Tarefas 3 e 5.
3. **Cancelamento em corrida com o tick**: o cliente cancela enquanto o tick muda o pedido para `executing`. `cancel_client_order` trava a linha (`for update`) e recusa `executing`. Teste na Tarefa 4.
4. **Aceite vencido**: um membro com autorização `pending` e `expires_at < now()` aparece como `expired`, o pedido não roda e o cancelamento funciona. Teste na Tarefa 4.
5. **Por sócio = 0**: Dossiê Empresarial com 3 sócios e `por_sócio = 0` cobra só a base, e o total continua > 0. Teste na Tarefa 2.

---

### Task 1: Autorização SCR tira a consulta de "Aguardando SCR" (item 18 da #72)

**Agent:** `database-architect` · **Depends-on:** none
**Files:**
- Modify: `db/migrations/022_orders_delivery.sql` (função `confirm_public_scr_authorization`, ~399-470)
- Create: `src/lib/orders/scr-confirm.integration.test.ts`

**Interfaces:**
- Produces: depois de `confirm_public_scr_authorization(..., p_decision => 'authorized', ...)` retornar sucesso, toda `consultations` com `scr_authorization_id` = essa autorização e `status = 'pending_authorization'` passa a `processing`, na mesma transação. Recusa (`refused`) não muda nada aqui (o tick já trata).

- [ ] **Step 1: Teste que falha** — `it("autorização SCR muda a consulta para processing antes do tick")`: abre um pedido de balcão (`placeOrder`) com 1 membro, lê o token da autorização, chama `confirm_public_scr_authorization` com decisão `authorized` e o código certo; espera `consultations.status = 'processing'` sem rodar o tick. Segundo caso: decisão `refused` mantém `pending_authorization`.
- [ ] **Step 2:** `npx vitest run src/lib/orders/scr-confirm.integration.test.ts` → FAIL (`pending_authorization`).
- [ ] **Step 3:** No ramo `authorized` da função, `update public.consultations set status = 'processing' where scr_authorization_id = <id> and status = 'pending_authorization'`. `db:reset`.
- [ ] **Step 4:** mesmo comando → PASS; `npx vitest run src/lib/orders` → PASS.
- [ ] **Step 5 (coordenador):** `fix(scr): autorização tira a consulta de pendente antes do tick (#72)`

### Task 2: Catálogo com 2 produtos e preço base + por sócio

**Agent:** `backend-specialist` · **Depends-on:** none
**Files:**
- Modify: `db/migrations/010_catalog.sql` (tabelas, guard, `resolve_product_terms`, `public_bureau_catalog`, grants, seed)
- Modify: `src/lib/catalog/queries.ts`, `src/lib/catalog/quote.ts`, `src/lib/bureaus/public.ts`, `src/actions/catalog.ts`, `src/actions/orders.ts` (só a chamada de `quoteOrder`), `src/test/seed.ts` (helpers de catálogo)
- Test: `src/lib/catalog/quote.test.ts`, `src/lib/catalog/catalog.integration.test.ts`, `src/lib/catalog/queries.integration.test.ts`, `src/lib/deps/catalog-seed.integration.test.ts`, `src/actions/catalog.test.ts`, `src/lib/bureaus/public.test.ts`

**Interfaces:**
- Schema (010):
  - `products`: sai `kind` e `addon_for` (e o CHECK `products_addon_for_kind`).
  - `product_versions`: `+ base_cost_per_partner numeric(15,2) not null default 0 check (base_cost_per_partner >= 0 and base_cost_per_partner <= 99999999.99)`.
  - `bureau_product_costs`: `cost check (cost >= 0 ...)`; `+ cost_per_partner numeric(15,2) not null default 0 check (cost_per_partner >= 0 and ...)`.
  - `bureau_catalog_items`: `+ sale_price_per_partner numeric(15,2) not null default 0 check (sale_price_per_partner >= 0 and ...)`; `sale_price > 0` continua.
  - Para `dossie_pf`, os campos por sócio ficam 0 e o guard recusa valor ≠ 0 (`catalog: per-partner price only for dossie_empresarial`).
  - Guard: recusa `sale_price < effective_cost` (mensagem atual) e `sale_price_per_partner < effective_cost_per_partner` (`catalog: partner price below partner cost`). Sai `cost not set` e a regra de add-on.
  - `resolve_product_terms(p_bureau_id uuid, p_product_id uuid) returns table (product_version_id uuid, effective_cost numeric, effective_cost_per_partner numeric)` — override mais recente (`cost`, `cost_per_partner`), senão os valores da versão vigente.
  - `public_bureau_catalog(p_slug text) returns table (code text, name text, sale_price numeric, sale_price_per_partner numeric)`; filtro: item ativo e as duas regras por campo.
  - Grants de coluna novos para `app_runtime` e `auth_profile_lookup` nos mesmos moldes das linhas 243-250.
  - Seed: só `('dossie_pf','Dossiê Pessoa Física')` e `('dossie_empresarial','Dossiê Empresarial Estruturado')`, versão 1, `base_cost 0.00`, `base_cost_per_partner 0.00`, DEPS acima.
- TS:
  - `CatalogConflict = "price_below_cost" | "partner_price_below_cost" | "per_partner_not_allowed" | "product_inactive"`.
  - `createProductVersion(identity, { productId, depsProduct, baseCost, baseCostPerPartner })`, `setBureauProductCost(identity, bureauId, productId, cost, costPerPartner)`, `upsertCatalogItem(identity, productId, { active, salePrice, salePricePerPartner })`; `CatalogEntry` ganha `effectiveCostPerPartner` e `item.salePricePerPartner`.
  - `QuoteLine = { productVersionId: string; code: string; part: "base" | "partner"; quantity: number; unitPriceCents: number; unitCostCents: number; priceCents: number; costCents: number }`.
  - `quoteOrder(identity: DbIdentity, productCode: "dossie_pf" | "dossie_empresarial", options: { partnerCount: number }): Promise<Quote>`; `Quote` falha só com `"product_not_for_sale"`.
  - `buildQuote(terms: { productVersionId: string; code: string; salePriceCents: number; salePricePerPartnerCents: number; costCents: number; costPerPartnerCents: number }, partnerCount: number): { lines: QuoteLine[]; totalPriceCents: number; totalCostCents: number }` exportada de `quote.ts` (função pura, reusada pelo portal na Tarefa 5). Linha `partner` só quando `partnerCount > 0`.
  - `PublicCatalogItem` ganha `salePricePerPartner`.
  - `seedProduct(owner, { code?, baseCost?, baseCostPerPartner?, depsProduct? })`, `seedBureauCost(owner, { ..., cost, costPerPartner? })`, `seedCatalogItem(owner, { ..., salePrice, salePricePerPartner? })`, `seedOrderCatalog(owner, session, { productCode, price, cost, pricePerPartner?, costPerPartner? })`.

- [ ] **Step 1: Testes que falham**
  - `quote.test.ts` `buildQuote`: venda base 100.00 / por sócio 30.00, custo 60.00 / 20.00 → n=0: `totalPriceCents 10000`, `totalCostCents 6000`, 1 linha; n=1: `13000`/`8000`, 2 linhas, linha partner `quantity 1`; n=3: `19000`/`12000`; por sócio 0 e n=3: `10000`/`6000`.
  - integração: `upsertCatalogItem` com `salePricePerPartner` abaixo do custo por sócio → `{ ok: false, reason: "partner_price_below_cost" }`; `dossie_pf` com por sócio ≠ 0 → `per_partner_not_allowed`; custo 0 aceito; `resolve_product_terms` devolve override e por sócio; `public_bureau_catalog` devolve `sale_price_per_partner` e esconde item que viola uma das regras.
  - seed: o catálogo tem exatamente `dossie_pf` e `dossie_empresarial` com os DEPS acima.
- [ ] **Step 2:** `npx vitest run src/lib/catalog src/lib/deps/catalog-seed.integration.test.ts src/actions/catalog.test.ts src/lib/bureaus/public.test.ts` → FAIL.
- [ ] **Step 3:** Implemente schema, funções, `triggerConflict`/`TRIGGER_REASONS`, `CONFLICT_MESSAGES` (pt-BR), validators do catálogo nas actions, helpers de seed e a chamada `quoteOrder(..., { partnerCount: partners.length })` em `src/actions/orders.ts`. `db:reset`.
- [ ] **Step 4:** mesmo comando → PASS; `npm run type-check` sem erro nos arquivos da tarefa.
- [ ] **Step 5 (coordenador):** `feat(catalog): 2 produtos com preço base mais valor por sócio`

### Task 3: Contrato do pedido — produtos novos, IA embutida, regras do portal e total por sócio

**Agent:** `backend-specialist` · **Depends-on:** Task 1, Task 2
**Files:**
- Modify: `db/migrations/022_orders_delivery.sql` (`dossier_orders`, `open_order`, `reserve_order`, grants)
- Modify: `src/lib/orders/types.ts`, `src/lib/orders/queries.ts`, `src/lib/orders/tick-queries.ts`, `src/lib/orders/ai.ts`, `src/lib/settlement/queries.ts`, `src/lib/settlement/types.ts`, `src/lib/validators/order.ts`, `src/actions/orders.ts`, `src/actions/orders-client.ts` (só para compilar: sem `withAi`, códigos novos)
- Test: `src/lib/orders/{orders,queries,tick,client-queries}.integration.test.ts`, `src/lib/settlement/{settlement,money-fixes,queries}.integration.test.ts`, `src/lib/validators/order.test.ts`, `src/lib/db/domain.integration.test.ts`

**Interfaces:**
- `dossier_orders`: `product_code check (product_code in ('dossie_pf','dossie_empresarial'))`; sai `with_ai`, `dossier_orders_ai` e `dossier_orders_full_counter`; `ai_status` com default `'pending'`.
- `open_order(p_product_code text, p_self boolean, p_subject_type text, p_subject_name text, p_subject_document text, p_partners jsonb, p_contact_email text, p_contact_phone text, p_buyer_profile_id uuid) returns table (ok boolean, reason text, dossier_id uuid, state text)` (sai `p_with_ai`). Regras:
  - Sócios só em `dossie_empresarial`, no balcão e no online; cada sócio com 11 dígitos e e-mail; 14 dígitos → `invalid_input`.
  - Online `dossie_pf`: conta com titular PF → só `self` (documento diferente do próprio → `third_party_not_allowed`); conta com titular PJ → exige `p_subject_type = 'PF'`, nome, CPF e `p_contact_email` do responsável.
  - Online `dossie_empresarial`: qualquer CNPJ, `p_contact_email` do responsável obrigatório.
  - D12 (`contact_is_buyer`, linhas ~755 e ~805): no online, o e-mail do membro igual ao do comprador só passa quando o documento do membro = documento do titular da conta do comprador (`holders.client_profile_id = v_user`). No balcão, sem mudança.
  - Auditoria `order.open`: sai `with_ai`; entra `self_member: true` quando algum membro é o próprio comprador.
- `reserve_order` (mesma assinatura): recalcula pelo pedido, não pela cotação:

```sql
-- n de sócios = membros do dossiê menos o titular principal
select count(*) - 1 into v_partners from public.consultations where dossier_id = p_order_ref;
select t.* into v_terms from resolve_product_terms(v_bureau, v_product_id) t;
v_price := v_item.sale_price + v_item.sale_price_per_partner * v_partners;
v_cost  := v_terms.effective_cost + v_terms.effective_cost_per_partner * v_partners;
if v_price <> p_price then return query select false, 'price_mismatch'::text, null::text; return; end if;
-- balcão: idem para p_cost (cost_mismatch); price >= cost continua (price_below_cost)
```
  Confirme no código que `p_order_ref = dossier_orders.dossier_id`; se não for, ache o dossiê pelo `order_ref`. As linhas de `p_quote` são gravadas como vieram (formato `QuoteLine` da Tarefa 2), depois de conferir os totais.
- TS: `OrderProductCode = "dossie_pf" | "dossie_empresarial"`; `OpenOrderInput` sem `withAi`; `OpenOrderFailure` + `"third_party_not_allowed"`; `SettlementFailure` + `"price_mismatch" | "cost_mismatch"` (se ainda não existirem); `ClientOrderListItem` sem `withAi`. `export const MAX_PARTNERS = 20` em `validators/order.ts`. Schemas:
  - `counterOrderSchema`: `productCode: z.enum(["dossie_pf","dossie_empresarial"])`, sem `withAi`, `partners` só aceito em `dossie_empresarial`.
  - `clientOrderSchema`: `productCode` igual; `subject` opcional; `contactEmail` opcional; `partners: z.array(partnerSchema).max(MAX_PARTNERS).default([])`; `declarationAccepted: z.boolean().default(false)`; refine: partners só em `dossie_empresarial`.
- Tick: o parecer roda para todo pedido concluído (troque toda checagem de `with_ai` por "sempre").

- [ ] **Step 1: Testes que falham** (integração, valores da Tarefa 2):
  - balcão `dossie_empresarial` com 0, 1 e 3 sócios reserva custo `60.00`, `80.00`, `120.00`; o mesmo CPF duas vezes conta 1; sócio com o CNPJ da empresa → `invalid_input`; sócio com 14 dígitos → `invalid_input`.
  - online `dossie_empresarial` com 2 sócios reserva venda `160.00` da carteira do cliente.
  - `reserve_order` com `p_price` diferente do recalculado → `price_mismatch`.
  - online conta PF `dossie_pf` com documento de outra pessoa → `third_party_not_allowed`; conta PJ `dossie_pf` com CPF e e-mail do responsável → abre.
  - D12: online, sócio com o e-mail do comprador e CPF = CPF da conta → abre; com outro CPF → `contact_is_buyer`; balcão com e-mail do comprador → `contact_is_buyer`.
  - tick: pedido concluído sem nenhuma flag gera parecer (`ai_status` vai de `pending` a `done` com o fake da IA).
  - `order.test.ts`: `clientOrderSchema` recusa `partners` em `dossie_pf`; aceita 20 e recusa 21.
- [ ] **Step 2:** `npx vitest run src/lib/orders src/lib/settlement src/lib/validators/order.test.ts src/lib/db/domain.integration.test.ts` → FAIL.
- [ ] **Step 3:** Implemente SQL, wrappers TS (`openOrder` sem `p_with_ai`, `OPEN_FAILURES`), validators e ajuste mínimo das actions para compilar. `db:reset`.
- [ ] **Step 4:** mesmo comando → PASS; `npm run type-check` → sem erro.
- [ ] **Step 5 (coordenador):** `feat(orders): produtos novos, parecer IA embutido e total por número de sócios`

### Task 4: Operações do cliente no banco — cancelar, listar membros e declaração

**Agent:** `database-architect` · **Depends-on:** Task 3
**Files:**
- Create: `db/migrations/025_client_order_ops.sql`
- Create: `src/lib/orders/client-ops.ts`, `src/lib/orders/client-ops.integration.test.ts`
- Modify: `src/lib/orders/types.ts` (`OrderStateReason` + `"cancelled_by_client"`), `src/lib/db/rls.integration.test.ts`

**Interfaces:**
- 025:
  - `dossier_orders.state_reason`: CHECK recriado com `'cancelled_by_client'`.
  - `cancel_client_order(p_dossier_id uuid) returns table (ok boolean, reason text)`, SECURITY DEFINER, `search_path = pg_catalog, public`: exige `app_user_role() = 'client'`, pedido do cliente (`client_profile_id = app_user_id()`, mesmo Bureau) → senão `not_found`; `select ... for update`; estado em `('awaiting_authorization','ready')` → senão `invalid_state`; faz o que `cancelOrder` faz hoje para a equipe (estado `cancelled`, motivo `cancelled_by_client`, consultas pendentes `rejected`, `release_order`, timeline e auditoria `order.cancel` na mesma transação).
  - `client_order_members(p_dossier_id uuid) returns table (role text, name text, document_masked text, scr_status text)`, SECURITY DEFINER, mesma checagem de posse; `role in ('company','partner','subject')`; `scr_status in ('pending','authorized','refused','expired')` (`expired` = pendente com `expires_at <= now()`); documento sempre mascarado.
  - `legal_documents.kind`: CHECK com `'buyer_declaration'`; seed `buyer_declaration` v1 e `terms` v2 com a cláusula, ambos com o texto marcado "TEXTO PROVISÓRIO — revisar com o jurídico".
  - Tabela `order_declarations (dossier_id uuid primary key references dossier_orders(dossier_id), bureau_id uuid not null, profile_id uuid not null, document_id uuid not null references legal_documents(id), accepted_at timestamptz not null default now(), ip inet, user_agent text check (length(user_agent) <= 512))`, imutável (`append_only_guard`), RLS: cliente lê as próprias; staff lê do Bureau.
  - `record_order_declaration(p_dossier_id uuid, p_version integer, p_ip inet, p_user_agent text) returns table (ok boolean, reason text)`, SECURITY DEFINER: posse do pedido; `p_version = legal_current_version('buyer_declaration')` → senão `outdated`; insere e audita `order.declaration_accepted`.
  - Grants de execute para `app_runtime`.
- `client-ops.ts`:
  - `cancelMyOrder(client: PoolClient, dossierId: string): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" }>`
  - `listMyOrderMembers(client: PoolClient, dossierId: string): Promise<OrderMember[]>` com `OrderMember = { role: "company" | "partner" | "subject"; name: string | null; documentMasked: string; scrStatus: "pending" | "authorized" | "refused" | "expired" }`
  - `recordOrderDeclaration(client: PoolClient, input: { dossierId: string; version: number; ip: string | null; userAgent: string | null }): Promise<{ ok: true } | { ok: false; reason: "not_found" | "outdated" }>`
  - `currentDeclarationVersion(client: PoolClient): Promise<number>`

- [ ] **Step 1: Testes que falham** (`client-ops.integration.test.ts`):
  - cancelar em `awaiting_authorization` e em `ready` → `ok`, carteira do cliente volta ao saldo de antes, motivo `cancelled_by_client`; em `executing` → `invalid_state`; pedido de outro cliente → `not_found`.
  - membros: empresa + 2 sócios com estados `authorized`, `pending` e pendente vencido → `authorized`, `pending`, `expired`; nenhum documento completo no retorno.
  - declaração: versão atual → `ok` e uma linha em `order_declarations`; versão antiga → `outdated`; segunda gravação do mesmo pedido falha.
  - RLS: `order_declarations` isolada por Bureau e por cliente.
- [ ] **Step 2:** `npx vitest run src/lib/orders/client-ops.integration.test.ts src/lib/db/rls.integration.test.ts` → FAIL.
- [ ] **Step 3:** Implemente a 025 e `client-ops.ts`. `db:reset`.
- [ ] **Step 4:** mesmo comando → PASS.
- [ ] **Step 5 (coordenador):** `feat(orders): cliente cancela com estorno, vê os aceites e grava a declaração`

### Task 5: Actions do portal e do balcão

**Agent:** `backend-specialist` · **Depends-on:** Task 2, Task 3, Task 4
**Files:**
- Modify: `src/actions/orders-client.ts`, `src/actions/orders.ts`, `src/lib/orders/queries.ts` (`placeOrder` com declaração opcional), `src/lib/orders/client-queries.ts` (se a página precisar de campos novos)
- Test: `src/actions/orders-client.test.ts`, `src/actions/orders.test.ts`, `src/actions/portal.integration.test.ts`

**Interfaces:**
- `placeOrder(identity, input: OpenOrderInput, quote: OrderQuote, options?: { declaration?: { version: number; ip: string | null; userAgent: string | null } })`: grava a declaração (`recordOrderDeclaration`) na mesma transação, depois de `open_order` e antes de `reserve_order`; falha → aborta tudo.
- `openClientOrderAction(values: unknown): Promise<ActionResult>`:
  - cota com `buildQuote` (Tarefa 2) a partir de `getPublicCatalog` e `partners.length`;
  - pedido "com membros" = `dossie_empresarial`, ou `dossie_pf` de conta PJ; nesse caso `declarationAccepted !== true` → `{ error: "Marque a declaração para continuar." }` sem abrir nada; com o aceite, passa `declaration` com a versão atual, IP (`requestMeta`) e user agent;
  - mensagens pt-BR novas em `CLIENT_ORDER_MESSAGES`: `third_party_not_allowed` ("No portal, o Dossiê Pessoa Física é só para você. Envie seu link para a outra pessoa consultar na conta dela."), `price_mismatch` ("O preço mudou. Revise e confirme de novo.").
- `cancelMyOrderAction(dossierId: unknown): Promise<ActionResult>`: `orderIdSchema` → `requireClient()` (`portal:write`) → `cancelMyOrder` em `withUserTransaction` → `revalidatePath("/portal/pesquisas")` e da página do pedido.
- `openCounterOrderAction`: `quoteOrder(session, productCode, { partnerCount })`, sem `withAi`.

- [ ] **Step 1: Testes que falham**
  - unit: pedido com membros sem `declarationAccepted` → erro e `placeOrder` não chamado; com o aceite → `placeOrder` recebe `declaration.version`; `dossie_pf` de conta PF não exige declaração.
  - integração (`portal.integration.test.ts`): o cliente abre `dossie_empresarial` com 2 sócios e declaração; o pedido fica `awaiting_authorization`; depois que os 3 membros autorizam, `refresh_order_state` dá `ready`; `cancelMyOrderAction` em outro pedido devolve o saldo.
  - preço alterado no catálogo entre a cotação e a confirmação → mensagem de `price_mismatch`.
- [ ] **Step 2:** `npx vitest run src/actions` → FAIL.
- [ ] **Step 3:** Implemente.
- [ ] **Step 4:** `npx vitest run src/actions src/lib/orders` → PASS; `npm run type-check` → sem erro.
- [ ] **Step 5 (coordenador):** `feat(portal): Dossiê Empresarial com sócios, declaração e cancelamento pelo cliente`

### Task 6: Telas de catálogo (superadmin e Bureau)

**Agent:** `frontend-specialist` · **Depends-on:** Task 2
**Files:**
- Modify: `src/components/superadmin/product-form.tsx`, `src/components/superadmin/product-version-form.tsx`, `src/components/superadmin/bureau-costs-panel.tsx`, `src/components/settings/catalog-form.tsx`, `src/app/(superadmin)/superadmin/products/**/page.tsx`, `src/app/(dashboard)/settings/catalog/page.tsx`
- Test: `src/components/superadmin/bureau-costs-panel.test.ts`, `src/components/settings/catalog-form.test.ts`

**Interfaces:**
- Consumes: actions e tipos da Tarefa 2 (`baseCostPerPartner`, `costPerPartner`, `salePricePerPartner`, `CatalogConflict`).
- Campos "Valor da empresa" e "Valor por sócio" só no Dossiê Empresarial; no Dossiê Pessoa Física, só "Valor". Sem campo de tipo/add-on no formulário de produto.
- O formulário do Bureau mostra o custo de cada campo ao lado e o erro por campo (`partner_price_below_cost` no campo por sócio).

- [ ] **Step 1: Testes que falham** — `catalog-form.test.ts`: Dossiê Pessoa Física não mostra "Valor por sócio"; Dossiê Empresarial mostra os dois; venda por sócio abaixo do custo mostra o erro no campo certo. `bureau-costs-panel.test.ts`: envia `cost` e `costPerPartner`.
- [ ] **Step 2:** `npx vitest run src/components/superadmin src/components/settings` → FAIL.
- [ ] **Step 3:** Implemente (shadcn/ui existente; invoque `/vercel:shadcn` e `/ui-ux-pro-max` antes).
- [ ] **Step 4:** mesmo comando → PASS.
- [ ] **Step 5 (coordenador):** `feat(catalog): telas de preço com valor da empresa e por sócio`

### Task 7: Telas do pedido — balcão, portal e acompanhamento de aceites

**Agent:** `frontend-specialist` · **Depends-on:** Task 4, Task 5
**Files:**
- Modify: `src/components/dossiers/dossier-form.tsx`, `src/components/dossiers/order-panel.tsx`, `src/components/orders/client-order-form.tsx`, `src/components/orders/client-order-list.tsx`, `src/app/(portal)/portal/pesquisas/nova/page.tsx`, `src/app/(portal)/portal/pesquisas/[id]/page.tsx`, `src/app/b/[slug]/page.tsx`, `src/lib/orders/labels.ts`
- Create: `src/components/orders/order-members.tsx`, `src/components/orders/cancel-order-button.tsx`
- Test: `src/components/orders/client-order-form.test.tsx`, `src/components/orders/order-members.test.tsx`

**Interfaces:**
- Consumes: `openClientOrderAction`, `cancelMyOrderAction` (Tarefa 5), `listMyOrderMembers`/`OrderMember` (Tarefa 4), `buildQuote` (Tarefa 2), `MAX_PARTNERS` (Tarefa 3).
- Balcão: escolha entre os 2 produtos; lista de sócios só no Dossiê Empresarial; total ao vivo (`buildQuote` com os preços do catálogo); sem checkbox de IA.
- Portal "nova": conta PF vê "Dossiê Pessoa Física (você)" e "Dossiê Empresarial Estruturado"; conta PJ vê o Dossiê Pessoa Física com CPF, nome e e-mail do responsável. Dossiê Empresarial: CNPJ, e-mail do responsável, sócios (nome, CPF, e-mail; adicionar/remover até 20), total ao vivo, checkbox obrigatório com o texto da declaração atual.
- Portal "[id]": `OrderMembers` com o estado de cada membro (Pendente, Autorizado, Recusado, Vencido); botão "Cancelar pedido" só em `awaiting_authorization`/`ready`, com confirmação; recusado ou vencido mostra "Este pedido não vai rodar. Cancele para receber o valor de volta."
- `order-panel.tsx` (equipe): sai a linha de adicional de IA; o parecer aparece como parte do dossiê.
- Vitrine `/b/[slug]`: mostra "a partir de R$ X + R$ Y por sócio" no Dossiê Empresarial.

- [ ] **Step 1: Testes que falham** — `client-order-form.test.tsx`: sem o checkbox, o botão de confirmar fica desabilitado no Dossiê Empresarial; total muda de R$ 100,00 para R$ 160,00 ao adicionar 2 sócios (venda 100 + 30/sócio); conta PJ vê os campos do responsável. `order-members.test.tsx`: renderiza os 4 estados e esconde o botão de cancelar quando nenhum estado permite.
- [ ] **Step 2:** `npx vitest run src/components/orders src/components/dossiers` → FAIL.
- [ ] **Step 3:** Implemente (invoque `/vercel:shadcn` e `/ui-ux-pro-max` antes).
- [ ] **Step 4:** mesmo comando → PASS; `npm run lint` sem erro novo.
- [ ] **Step 5 (coordenador):** `feat(ui): pedidos com os 2 dossiês, sócios, total ao vivo e acompanhamento de aceites`

### Task 8: E2E e documentos

**Agent:** `qa-automation-engineer` · **Depends-on:** Task 6, Task 7
**Files:**
- Modify: `e2e/fixtures.ts`, `e2e/counter-order.spec.ts`, `e2e/portal-order.spec.ts`
- Modify: `PRODUCT.md` (seção Catálogo e Parecer IA; afiliados como próxima entrega), `docs/architecture.md` (seção de dados: 025), `docs/operations/orders.md`

**Interfaces:**
- e2e balcão: Dossiê Empresarial com 2 sócios até `ready` (fluxo atual com os produtos novos).
- e2e portal: Dossiê Empresarial com 1 sócio → declaração → página do pedido mostra os membros → cancelar → saldo volta.

- [ ] **Step 1:** Ajuste fixtures e specs.
- [ ] **Step 2:** `npm run test:e2e -- counter-order portal-order` → PASS.
- [ ] **Step 3:** Atualize os 3 documentos (texto STE, sem duplicar regra).
- [ ] **Step 4:** `npm run check` → verde.
- [ ] **Step 5 (coordenador):** `test(e2e): dossiês novos no balcão e no portal; docs`

## Ondas

| Onda | Tarefas | Motivo |
|---|---|---|
| 1 | 1, 2 | arquivos disjuntos, sem dependência |
| 2 | 3, 6 | 3 depende de 1 e 2; 6 depende de 2; arquivos disjuntos |
| 3 | 4 | depende de 3 |
| 4 | 5 | depende de 2, 3, 4 |
| 5 | 7 | depende de 4, 5 |
| 6 | 8 | fim |

Revisão única no fim da issue (`/code-review`, `code-reviewer` + `security-reviewer`). Post-deploy: um Dossiê Empresarial real com sócios conclui na DEPS e o valor bate com o extrato; texto da declaração e cláusula dos Termos revisados pelo jurídico.
