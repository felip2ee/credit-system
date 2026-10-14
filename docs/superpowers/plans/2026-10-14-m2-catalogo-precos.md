# M2 — Catálogo e preços Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: execute com `superpowers:subagent-driven-development` em **ondas paralelas** (`Files:` / `Depends-on:`, regra `.claude/rules/08-parallel-subagent-driven-development.md`). Os implementadores **não fazem commit**: deixam as mudanças na árvore e reportam `Files changed`. O controlador faz um commit por task, na ordem do plano. Sem reviewer por task. Steps usam checkbox (`- [ ]`).

**Goal:** O superadmin cadastra produtos base e custos. Cada Bureau escolhe produtos e define preço de venda. O Parecer IA é um adicional com preço próprio. `/b/<slug>` lista o catálogo.

**Architecture:** Uma migration nova (`010_catalog.sql`) cria 4 tabelas, triggers, RLS e 2 funções. `products` e `product_versions` são globais (modelo de `settings`). `bureau_product_costs` e `bureau_catalog_items` são de tenant (modelo do M1). Camadas: Server Action → `src/lib/catalog/queries.ts` → SQL parametrizado.

**Tech Stack:** Next.js 14.2, PostgreSQL 18.6 (RLS), node-postgres, zod, Vitest 4, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-14-m2-catalogo-precos-design.md`. Issues: #22, #23, #24, #25. Base: M1 merged.

## Global Constraints

- Crie `db/migrations/010_catalog.sql`. Não edite as migrations 003–009. Recrie o banco de dev antes dos testes de integração: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.
- Testes de integração (`*.integration.test.ts`) rodam contra `127.0.0.1:54329` e usam `src/test/seed.ts`.
- Passe a identidade (`session`/`DbIdentity`) inteira. Chame `hasPermission(subject, permission)` com o objeto.
- `bureau_id` de escrita vem da identidade. Exceção única: as actions do superadmin em `bureau_product_costs` recebem o `bureau_id` alvo, validado por zod (uuid) e por `bureaus:manage`.
- Dinheiro: `numeric(15,2)`; em TypeScript, string decimal; compare em centavos inteiros; nunca `number` de ponto flutuante. Faixa: `> 0` e `<= 99999999.99`.
- Auditoria no mesmo cliente da transação. Nunca CPF/CNPJ em `metadata`.
- Server Actions: zod `safeParse` → `getRequiredSession` → `hasPermission` → query → `revalidatePath`; retorno `{ error: string | null, id? }`. Queries retornam `{ ok: false, reason }` para conflito de negócio.
- Identificadores em inglês. UI, erros e comentários em pt-BR.
- Nenhum literal `"Smart PF"`/`"Smart PJ"` fora de `src/lib/deps/products.ts` e do seed SQL.
- **Gate da task:** os testes do escopo da task passam. `npm run lint && npm run type-check && npm run test` passam no fim da última onda.
- Implementadores: agente especialista com `model: "sonnet"`. Nunca `opus`.
- Commits: um por task, Conventional Commits, `Closes #n` no corpo quando a task fecha a issue, linha final `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Rode `git rev-parse --short HEAD` antes e registre o hash. `git add` só dos `Files:` da task.

## Review Focus

1. Superadmin lê dados pessoais pela exceção de custo — Task 1: `superadmin without support reads zero rows of other tenant tables`.
2. Admin do Bureau A lê ou grava custo, preço ou item do Bureau B — Task 1: `cross-bureau catalog access denied`.
3. Preço abaixo do custo passa por uma rota que não é a query (UPDATE direto, custo subindo) — Task 1: `trigger rejects price below cost`; Task 2: `cost above price removes item from sale`.
4. Erro de arredondamento em dinheiro — Task 2: `0.10 + 0.20 equals 0.30 in cents`.
5. Catálogo público vaza custo, `deps_product` ou Bureau inativo — Task 1: `public_bureau_catalog columns and inactive bureau`.

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `db/migrations/010_catalog.sql` | tabelas, triggers, RLS, funções, seed | 1 |
| `src/test/seed.ts` | helper de produto e item de catálogo (acrescenta, não muda o existente) | 1 |
| `src/lib/catalog/catalog.integration.test.ts` | isolamento, imutabilidade, trigger, função pública | 1 |
| `src/lib/db/permissions.ts` | permissões `catalog:read`, `catalog:write` | 2 |
| `src/lib/audit/write.ts` | `bureauId` explícito opcional no evento | 2 |
| `src/lib/catalog/{money,queries,quote}.ts` e testes | regra de preço, queries, `quoteOrder` | 2 |
| `src/lib/validators/catalog.ts` | schemas zod | 2 |
| `src/actions/catalog.ts` e teste | Server Actions | 2 |
| `src/app/(superadmin)/superadmin/products/`, `…/bureaus/[id]/` (seção Custos), `src/components/superadmin/` | telas do superadmin | 3 |
| `src/app/(dashboard)/settings/catalog/`, `src/components/settings/catalog-form.tsx`, `src/app/b/[slug]/page.tsx`, `src/lib/bureaus/public.ts` | catálogo do Bureau e vitrine | 4 |

**Arquivos compartilhados e dono único:** `src/components/superadmin/SuperadminNav.tsx` → Task 3 (link "Produtos"). `src/components/layout/Sidebar.tsx` → Task 4 (link "Catálogo"). `src/lib/bureaus/public.ts` → Task 4.

## Ondas

| Onda | Tasks | Por quê |
|---|---|---|
| 1 | 1 | schema e RLS são a base |
| 2 | 2 | usa as tabelas e funções da Task 1 |
| 3 | 3, 4 | só consomem a Task 2; arquivos disjuntos |

---

### Task 1: Schema, RLS, funções e testes de isolamento (refs #22, #23, #24, #25)

**Agent:** `database-architect` (`model: "sonnet"`). Invoque `/postgresql-database-engineering`.
**Depends-on:** none
**Files:**
- Create: `db/migrations/010_catalog.sql`, `src/lib/catalog/catalog.integration.test.ts`
- Modify: `src/test/seed.ts` (acrescente helpers; não altere os existentes)

**Contrato (spec, "Modelo de dados" e decisões 2–6, 10–11, 14):**
- `products`, `product_versions`: globais; leitura `superadmin`/`bureau_admin`/`operator`; escrita só `superadmin` (modelo das políticas de `settings` em `004_rls.sql`).
- `product_versions`: trigger bloqueia UPDATE e DELETE para todos os roles.
- `bureau_product_costs`: só INSERT (sem grant de UPDATE/DELETE). Política: o superadmin lê e insere para qualquer Bureau **sem** sessão de suporte; `bureau_admin` e `operator` leem só `bureau_id = app_bureau_id()`; ninguém mais. FK composta `(bureau_id)` → `bureaus`.
- `bureau_catalog_items`: PK `(bureau_id, product_id)`. Política de tenant padrão do M1 (`bureau_id = app_bureau_id() and app_is_staff()`); escrita só `bureau_admin`. Superadmin sem suporte lê zero linhas. Trigger BEFORE INSERT/UPDATE: rejeita `sale_price < custo efetivo` e rejeita ativar `addon` sem produto `main` compatível ativo no mesmo Bureau.
- Função `resolve_product_terms(p_bureau_id uuid, p_product_id uuid)` → `product_version_id`, `effective_cost`. Custo efetivo = override vigente, senão `base_cost` da versão vigente.
- Função `public_bureau_catalog(p_slug text)` (SECURITY DEFINER, dono `schema_owner`, `grant execute` a `app_runtime`): devolve `code, name, kind, sale_price` só de itens com `active` e `sale_price >= custo efetivo` e custo efetivo `> 0`, de Bureau ativo. Para `addon`, exige `main` compatível à venda.
- Seed: 4 produtos (`consulta_pf`, `consulta_pj`, `dossie_pj_completo`, `parecer_ia`), versão 1 de cada, `base_cost 0.00`. `deps_product`: `Smart PF 002` (PF), `Smart PJ 010` (PJ e dossiê), nulo (IA).

**Testes (cada um nomeado como abaixo):**
- `product_versions immutable`: UPDATE e DELETE falham com o role da aplicação.
- `superadmin without support reads zero rows of other tenant tables`: `bureau_catalog_items`, `holders`.
- `superadmin reads and inserts bureau_product_costs without support`.
- `cross-bureau catalog access denied`: admin do Bureau A não lê nem grava item ou custo do Bureau B.
- `operator reads catalog and cannot write`.
- `trigger rejects price below cost` (INSERT e UPDATE).
- `addon needs compatible main`.
- `public_bureau_catalog columns and inactive bureau`: sem custo e sem `deps_product`; zero linhas para Bureau inativo e inexistente.
- `resolve_product_terms uses override then base cost`.

**Gate:** `npx vitest run src/lib/catalog/catalog.integration.test.ts` passa após `db:reset`.

---

### Task 2: Domínio de catálogo, permissões, auditoria e actions (refs #22, #23, #24, #25)

**Agent:** `backend-specialist` (`model: "sonnet"`).
**Depends-on:** 1
**Files:**
- Create: `src/lib/catalog/money.ts`, `src/lib/catalog/queries.ts`, `src/lib/catalog/quote.ts`, `src/lib/validators/catalog.ts`, `src/actions/catalog.ts`
- Create (testes): `src/lib/catalog/money.test.ts`, `src/lib/catalog/queries.integration.test.ts`, `src/lib/catalog/quote.test.ts`, `src/actions/catalog.test.ts`, `src/lib/deps/catalog-seed.integration.test.ts`
- Modify: `src/lib/db/permissions.ts`, `src/lib/audit/write.ts`

**Contrato:**
- Permissões (decisão 9): `superadmin` = `catalog:read`, `catalog:write`; `bureau_admin` = os dois; `operator` = `catalog:read`; `client` = nenhuma. Em suporte, o superadmin mantém o conjunto do operador mais o seu.
- `money.ts`: `toCents(value: string): number` (rejeita fora da faixa, mais de 2 casas e formato inválido); `fromCents(cents: number): string`; `isPriceSellable(priceCents, costCents): boolean` (`cost > 0 && price >= cost`).
- `AuditEvent` ganha `bureauId?: string`. Só as actions do superadmin em custo passam esse valor; o helper o ignora para qualquer outro papel (teste prova que um operador não consegue forçar `bureauId`). `platformIdentity` (em `src/lib/db/transaction.ts`) é o ponto de partida; leia-o antes de mudar o helper.
- `queries.ts` (uma função por operação, sempre dentro de `withUserTransaction`):
  - superadmin: `createProduct`, `updateProduct`, `createProductVersion`, `listProducts`, `setBureauProductCost(identity, bureauId, productId, cost)`, `listBureauCosts(identity, bureauId)`;
  - bureau_admin: `listCatalog(identity)` (produto, item, custo efetivo, `sellable`), `upsertCatalogItem(identity, productId, { active, salePrice })` com `select … for update` e validação de preço e de adicional;
  - qualquer staff: `getEffectiveTerms(identity, productId)`.
  - Conflito de negócio retorna `{ ok: false, reason }` com `reason` em `price_below_cost | cost_not_set | addon_requires_main | product_inactive`.
- `quote.ts`: `quoteOrder(identity, productCode, { withAi }): Promise<{ ok: true; lines: { productVersionId; code; costCents; priceCents }[]; totalCostCents; totalPriceCents } | { ok: false; reason }>`. Falha se o produto ou o adicional não está à venda.
- Auditoria: `catalog.product.create|update|version`, `catalog.cost.set` (bureau alvo, `old_cost`, `new_cost`), `catalog.item.upsert` (`old_price`, `new_price`, `active`).
- `actions/catalog.ts`: uma action por query de escrita; superadmin exige `catalog:write` e `bureaus:manage` onde o Bureau é parâmetro; `bureau_admin` exige `catalog:write` e nunca recebe `bureauId` do formulário.
- `catalog-seed` test: os nomes DEPS do seed SQL (lidos do banco) são iguais a `DEPS_PRODUCT_PF` e `DEPS_PRODUCT_PJ` de `src/lib/deps/products.ts`.

**Testes obrigatórios:** `0.10 + 0.20 equals 0.30 in cents`; faixa e casas decimais; `cost above price removes item from sale` (sem alterar `sale_price`); evento de auditoria com valor antigo e novo; `operator cannot force bureauId in audit`; `addon leaves sale when last compatible main leaves`; `quoteOrder sums product and addon with current versions`; permissão por papel (`bureau_admin` não chama action de produto base).

**Gate:** `npx vitest run src/lib/catalog src/actions/catalog.test.ts src/lib/deps` passa.

---

### Task 3: Telas do superadmin (refs #22, #23)

**Agent:** `frontend-specialist` (`model: "sonnet"`). Invoque `/vercel:nextjs` e `/vercel:shadcn`.
**Depends-on:** 2
**Files:**
- Create: `src/app/(superadmin)/superadmin/products/page.tsx`, `src/app/(superadmin)/superadmin/products/new/page.tsx`, `src/app/(superadmin)/superadmin/products/[id]/page.tsx`, `src/components/superadmin/{ProductForm,ProductVersionForm,BureauCostsPanel}.tsx`
- Modify: `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx` (seção "Custos"), `src/components/superadmin/SuperadminNav.tsx` (link "Produtos")

**Contrato:** consome as actions e `listProducts`, `listBureauCosts` da Task 2. Telas conforme a tabela "Telas" da spec. A lista mostra código, nome, tipo, estado e versão vigente. `[id]` mostra o histórico de versões e o formulário de nova versão (nome DEPS e custo padrão). "Custos" mostra custo efetivo, origem (padrão ou override), formulário de override e histórico. Mensagens de erro mapeiam cada `reason`. Siga o padrão visual de `BureauCreateForm`/`BureauEditForm`.

**Teste:** `ProductVersionForm` e `BureauCostsPanel` têm validação de dinheiro e renderização condicional: um teste de componente cada (valor inválido mostra erro; override mostra origem "Override"). Telas de listagem: sem teste.

**Gate:** `npx vitest run src/components/superadmin` passa; `npm run type-check` passa para os arquivos da task.

---

### Task 4: Catálogo do Bureau e vitrine pública (refs #24, #25)

**Agent:** `frontend-specialist` (`model: "sonnet"`). Invoque `/vercel:nextjs` e `/vercel:shadcn`.
**Depends-on:** 2
**Files:**
- Create: `src/app/(dashboard)/settings/catalog/page.tsx`, `src/components/settings/catalog-form.tsx` (arquivo novo; padrão dos outros formulários de `settings`), `src/lib/bureaus/public.test.ts`
- Modify: `src/lib/bureaus/public.ts` (acrescenta `getPublicCatalog(slug)` chamando `public_bureau_catalog`), `src/app/b/[slug]/page.tsx` (lista os itens ou "Catálogo em breve"), `src/components/layout/Sidebar.tsx` (link "Catálogo")

**Contrato:** `/settings/catalog` mostra cada produto com custo efetivo, preço, interruptor ativo e o aviso "Preço abaixo do custo" quando `sellable` é falso por preço. O operador vê a tela sem controles de gravação (`catalog:read` sem `catalog:write`). O adicional aparece sob os produtos `main` compatíveis, desabilitado com a razão `addon_requires_main`. Preço em reais com máscara pt-BR; o envio usa string decimal. `getPublicCatalog` valida o slug com `SLUG_PATTERN` e devolve `[]` para slug inválido. A página mantém o 404 do M1 para Bureau inexistente ou inativo e não mostra custo.

**Testes:** `getPublicCatalog returns [] for invalid slug`; `catalog-form` mostra o aviso quando preço < custo e desabilita os controles sem `catalog:write`.

**Gate:** `npx vitest run src/lib/bureaus src/components/settings` passa.

---

## Pós-plano (pipeline, não são tasks)

1. `npm run lint && npm run type-check && npm run test`.
2. `/code-review` uma vez sobre o diff inteiro do M2 (`code-reviewer` + `security-reviewer`; foco em RLS, exceção do superadmin e dinheiro). Corrija P0/P1.
3. Abra o PR com `Closes #22 #23 #24 #25`.
4. **Post-deploy follow-up** (item único no corpo do PR): o superadmin define o custo real de cada produto no Bureau de produção antes de abrir vendas.
