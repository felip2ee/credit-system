# Comissão dos Bureaus — design

Data: 2026-11-19. Estado: decisões do dono fechadas. Sem perguntas abertas. Substitui o modelo "custo por Bureau + preço do Bureau" de `2026-10-13-plataforma-bureau-produto-design.md` (M2). Muda a base da comissão de afiliados de `2026-10-24-programa-de-afiliados-design.md`.

## 1. Resultado

Só o superadmin define produtos, preço de venda, a % do Bureau, a % de afiliados do Bureau e o bloqueio de produto por Bureau. O Bureau não edita nada disso e não tem custo. O Bureau recebe uma % do preço bruto de cada venda. A plataforma fica com o resto. A comissão do afiliado também é % do preço bruto e sai da parte da plataforma, nunca da parte do Bureau.

Exemplo: preço R$ 400,00, Bureau 20%, afiliado 10%.

| Parte | Conta | Valor |
|---|---|---|
| Bureau | 400,00 × 20% | 80,00 |
| Afiliado | 400,00 × 10% | 40,00 |
| Plataforma | 400,00 − 80,00 − 40,00 | 280,00 |

Venda de balcão (sem afiliado), mesmo preço: o Bureau recebe 400,00 do cliente, a plataforma debita 320,00 da carteira pré-paga do Bureau. O Bureau fica com 80,00.

Nenhum preço nem % é gravado no deploy. Até o superadmin definir os valores nas telas dele, o sistema não vende (seção 6).

## 2. Modelo de dados

Migration única: `db/migrations/048_platform_pricing_commission.sql`. Nenhuma migration aplicada muda.

### Preço de venda (só superadmin)

- `product_versions` ganha `sale_price numeric(15,2)` (nulo, `> 0`, `<= 99999999.99`) e `sale_price_per_partner numeric(15,2) not null default 0` (mesmos limites). A tabela é imutável: mudar preço = nova versão (o formulário de nova versão já existe e já audita `catalog.product.version`).
- Produto à venda = `products.active`, a **última** versão tem `sale_price` não nulo e o Bureau não o bloqueou. Versão sem preço = "não à venda" (falha fechada). Não há queda para versão antiga.
- Preço por sócio só vale em `dossie_empresarial`. `dossie_pf` exige `0` (validação no zod e na action).
- `base_cost` e `base_cost_per_partner` ficam como custo interno da plataforma (DEPS). O Bureau não os usa. A tela de nova versão recusa `sale_price < base_cost` (mesma regra `isPriceSellable`) e avisa se a parte da plataforma ficar abaixo do custo.
- Função nova `current_product_price(p_product_id uuid)` devolve `product_version_id, sale_price, sale_price_per_partner` da última versão com preço. Dono `schema_owner`, `grant execute` a `app_runtime` e `auth_profile_lookup` (molde de `resolve_product_terms`).

### % do Bureau

- Chave nova em `settings`: `bureau_commission_pct` (jsonb número, de 0 a 99,99, até 2 casas). `check` na tabela, como `settings_payable_retention_days_check` (046). Política `settings_gateway_bureau_commission` para `auth_profile_lookup`, só esta chave. A chave não tem valor inicial: sem ela, o sistema recusa novas reservas (`commission_not_configured`).
- Override por Bureau: tabela nova `bureau_commission_rates` (append-only, molde de `bureau_product_costs`):

| Coluna | Regra |
|---|---|
| `id` | `bigint generated always as identity`, desempata |
| `bureau_id` | fk `bureaus` |
| `pct` | `numeric(5,2)`, nulo ou de 0 a 99,99. Nulo = volta ao global |
| `set_by` | fk `profiles` |
| `created_at` | `timestamptz` |

  Vale a linha de maior `id` do Bureau. Trigger `append_only_guard` e sem `truncate`.
- Função nova `resolve_bureau_commission_pct(p_bureau_id uuid) returns numeric`: `coalesce(última linha.pct, settings global)`; nulo se nenhum existe. Dono `auth_profile_lookup`, definer.
- Teto de 99,99%: o Bureau nunca fica com 100% do preço. Com preço baixo e % alta, o arredondamento pode dar `cost = 0` (ver 3.3).

### Bloqueio de produto por Bureau

Tabela nova `bureau_product_blocks` (append-only, mesmo molde):

| Coluna | Regra |
|---|---|
| `id` | `bigint generated always as identity` |
| `bureau_id` | fk `bureaus` |
| `product_id` | fk `products` |
| `blocked` | `boolean not null` |
| `set_by` | fk `profiles` |
| `created_at` | `timestamptz` |

Vale a linha de maior `id` do par (Bureau, produto). Sem linha = liberado. `blocked = false` desfaz o bloqueio e mantém o histórico. Função `product_blocked_for_bureau(p_bureau_id, p_product_id) returns boolean` (definer, dono `auth_profile_lookup`, `grant execute` a `app_runtime`).

Onde vale: `open_order`, `reserve_order`, `public_bureau_catalog` e `listCatalog`/`quoteOrder`. Produto bloqueado = "não à venda" (`product_not_for_sale` / `quote_mismatch`). Pedido já reservado segue até a captura. O Dossiê Pessoa Física usado como produto DEPS de sócio no Empresarial (passo 5 de `open_order`) não depende do bloqueio, como hoje não depende de estar à venda.

### Liquidação (snapshot imutável)

`order_settlements` ganha `commission_pct numeric(5,2)` e `bureau_commission numeric(15,2)`, ambos nulos em pedido antigo.

- `check`: `(commission_pct is null) = (bureau_commission is null)`; se não nulos, `bureau_commission = round(price * commission_pct / 100, 2)` e `cost = price - bureau_commission`.
- Significado novo de `cost` (pedidos novos): **parte da plataforma** = `price - bureau_commission`. O `check price >= cost` continua válido. Pedido antigo (`commission_pct` nulo) mantém o significado antigo (custo de atacado).
- O trigger `order_settlements_guard` já impede mudar qualquer coluna depois de gravada. `quote.lines` guarda só preço por linha (sem custo por linha).

### Tabelas antigas (legado, só leitura)

- `bureau_catalog_items`: nenhuma função nova a lê. A migration remove as políticas de insert e update do admin do Bureau. A tabela fica com as linhas para histórico. O liga/desliga do Bureau acaba; vale o bloqueio do superadmin.
- `bureau_product_costs`: a migration remove a política `bureau_product_costs_superadmin_insert` e faz `revoke insert` de `app_runtime`. Fica só para histórico. `resolve_product_terms` não muda.
- `affiliate_rates`: a migration remove as políticas de insert, update e delete do admin do Bureau e não cria nenhuma de escrita. A tabela fica só para histórico. Nenhuma função a lê para comissão nova.
- `affiliate_commissions.margin`: a coluna fica (renomear quebra o histórico). Em comissão nova guarda a **base** (preço bruto). Comentário `comment on column` na migration. Comissão antiga guarda a margem.

### Afiliados: uma % por Bureau

`bureau_affiliate_settings.default_pct` passa a ser **a** % de afiliados do Bureau, para todos os afiliados dele. Só o superadmin escreve. Não há % por afiliado. `affiliate_commissions.pct` continua a % gravada na captura.

## 3. Regras de dinheiro

### 3.1 Reserva (`reserve_order`, redefinida a partir de 022)

O servidor monta tudo (como hoje). Troca só a origem do preço e do custo:

1. Produto: `products.active`, `current_product_price(p.id)` com `sale_price` não nulo e `product_blocked_for_bureau` falso. Senão `quote_mismatch`.
2. `price = sale_price + sale_price_per_partner × sócios`.
3. `pct = resolve_bureau_commission_pct(bureau)`. Nulo = `commission_not_configured` (motivo novo em `SettlementFailure`).
4. `bureau_commission = round(price × pct / 100, 2)`; `cost = price − bureau_commission`.
5. Grava `price, cost, commission_pct, bureau_commission`. A conferência do chamador fica: `price_mismatch` (online e balcão) e `cost_mismatch` (balcão).

`open_order` (044) troca a mesma consulta de catálogo (passo 3 da função) pela nova regra de "à venda" (preço presente, não bloqueado). Só essa consulta muda; o resto é cópia.

### 3.2 Captura (`capture_order`, redefinida a partir de 027)

Ramo novo quando `commission_pct is not null`. O ramo antigo (`commission_pct` nulo) fica idêntico ao de 027, para reservas feitas antes do deploy (e ele continua lendo `affiliate_rates`, como em 027).

```
bureau   = bureau_commission                       -- já gravado
aff      = least(round(price × aff_pct / 100, 2), price − bureau)
platform = price − bureau − aff
```

- Arredondamento: `round(x, 2)` do Postgres (meio para cima). Bureau e afiliado arredondam sozinhos. **A plataforma absorve o centavo**: `platform = price − bureau − aff` e `bureau + aff + platform = price` sempre. O `least` garante `platform >= 0` quando as duas % somam 100.
- Online: `accrual = bureau_commission` (se `> 0`) em `bureau_payable_entries`. Não desconta a comissão do afiliado.
- Afiliado: mesmas condições de hoje (vínculo, telefone verificado, afiliado ativo e não anonimizado). Base = `price` (não mais `price − cost`). `aff_pct` = `bureau_affiliate_settings.default_pct` do Bureau (0 se não há linha). Insere comissão `margin = price`, `amount = aff`, só se `aff > 0`, com `pct = aff_pct`.
- Trava `bureau_pct + aff_pct <= 100`: na escrita (seção 4) e, como rede de segurança, o `least` acima.
- Ordem de travas e auditoria `affiliate.commission` não mudam.

### 3.3 Balcão

Hoje (015/022): o cliente paga o Bureau fora do sistema (`counter_payments`). `reserve_order` reserva `cost` na carteira pré-paga do Bureau. `capture_order` captura `cost`. Nenhum `bureau_payable_entries` nasce e não há afiliado (sem `client_profile_id`).

Proposta mínima: nenhuma mudança de fluxo. `cost` já é a parte da plataforma (3.1). O Bureau retém `price` do cliente, paga `price − bureau_commission` à plataforma pela carteira e fica com `bureau_commission`. Equivale ao online.

Detalhes: `pct = 0` dá `cost = price`. `cost = 0` pode ocorrer (preço R$ 0,01 com `pct >= 50` dá parte da plataforma 0,00): `reserve_order` pula a reserva (`v_cost > 0`) e a captura trata `cost = 0`. A tela do balcão troca o rótulo "Custo" por "Repasse à plataforma".

### 3.4 Estorno e chargeback

Sem mudança. O estorno de Pix/cartão (`apply_asaas_payment`, 045) reverte a **recarga** do cliente, não o pedido. Esta entrega **não altera** esse SQL.

- Comissão do afiliado pendente: continua a ser revertida primeiro, da mais nova para a mais antiga, até cobrir a falta. Agora isso devolve dinheiro à plataforma (que pagou a comissão).
- O que sobra continua a ser clawback do Bureau, só até o valor a repassar ainda não pago (`bureau_payable_entries`, lock `payout:<bureau>`). Depois, `refund_shortfall`.
- Comissão `released` não é tocada. Não há reversão por pedido.

### 3.5 Imutabilidade do snapshot

- Preço, `cost`, `commission_pct` e `bureau_commission` ficam no `order_settlements` na reserva e nunca mudam (trigger de 015).
- Mudar o preço (nova versão), a % global, o override, a % de afiliados ou o bloqueio só vale para reservas e capturas futuras.
- Comissão de afiliado já gravada não muda ao mudar a % (teste existente continua).

## 4. Permissões, RLS e auditoria

| Ação | Quem | Como |
|---|---|---|
| Preço do produto (nova versão) | superadmin, sem suporte | `product_versions_superadmin_insert` (já existe); permissão `catalog:write` |
| `bureau_commission_pct` global | superadmin | política de `settings` existente; permissão `settings:write`; action `saveBureauCommissionAction` via `upsertSettings` |
| Override por Bureau | superadmin, sem suporte | insert em `bureau_commission_rates`; permissão `bureaus:manage` |
| Bloqueio de produto por Bureau | superadmin, sem suporte | insert em `bureau_product_blocks`; permissão `bureaus:manage` |
| % de afiliados do Bureau | superadmin, sem suporte | políticas de `bureau_affiliate_settings`: **remove** as de `bureau_admin`, **cria** as de `superadmin` (`app_support_session_id() is null`); permissão `affiliates:manage` |
| Preço, custo, produto e % de afiliado pelo Bureau | ninguém | `catalog:write` e `affiliates:manage` saem de `bureau_admin`; políticas de escrita de `bureau_catalog_items` e `affiliate_rates` removidas |

Permissões em `src/lib/db/permissions.ts`:

- `bureau_admin`: remove `catalog:write` e `affiliates:manage`. Ganha `affiliates:read` (lista e % em leitura).
- `superadmin`: ganha `affiliates:manage`.
- `operator`: sem mudança.

Leitura: `bureau_commission_rates` e `bureau_product_blocks` — superadmin (sem suporte) e equipe do próprio Bureau (a tela mostra a % efetiva e os produtos bloqueados). O cliente nunca vê `cost`, a % nem o bloqueio (vê só o catálogo público).

Concessões à `auth_profile_lookup` (molde 027): `select` em `bureau_commission_rates` e `bureau_product_blocks` (política `using (true)`), `select (key, value)` em `settings` para a chave nova, `select (sale_price, sale_price_per_partner)` em `product_versions`.

Auditoria, na mesma transação, sem documento no metadata:

| Ação | Alvo | Metadata |
|---|---|---|
| `catalog.product.version` (existe) | `product_versions` | + `sale_price`, `sale_price_per_partner`, valores antigos |
| `settings.bureau_commission` | `settings` | `from`, `to` |
| `commission.bureau_set` | `bureaus` | `from`, `to` (nulo = global), `bureau_id` |
| `catalog.block_set` | `products` | `bureau_id`, `product_id`, `blocked` |
| `affiliate.rate` (existe) | `bureau_affiliate_settings` | `scope: "default"`, `bureau_id`, `from`, `to`; o ator agora é o superadmin |

A política `audit_logs_insert` (017) só aceita um superadmin sem suporte com `bureau_id` para `catalog.cost.set`. A migration acrescenta `commission.bureau_set`, `catalog.block_set` e `affiliate.rate` a esse ramo (mesmas condições: sem sessão de suporte, `bureau_id` não nulo).

Trava `bureau_pct + affiliate_pct <= 100`, na mesma transação da escrita: depois de gravar a % global, o override ou a % de afiliados do Bureau, uma consulta acha qualquer Bureau com `pct efetivo + default_pct > 100`. Achou: `throw` desfaz tudo e a action devolve `split_over_100`. Para a % global a consulta olha todos os Bureaus; para os outros dois, só o Bureau alterado.

## 5. Interface (pt-BR)

Remover ou trocar:

| Arquivo | Mudança |
|---|---|
| `src/components/settings/catalog-form.tsx` (+ `.test.ts`) | Sai. Vira tabela somente leitura. |
| `src/app/(dashboard)/settings/catalog/page.tsx` | Lista produtos à venda para o Bureau, preço, preço por sócio e "Sua comissão: X%" (somente leitura). Produto bloqueado não aparece. Sem campos. |
| `src/actions/catalog.ts` | Remove `upsertCatalogItemAction` e `setBureauProductCostAction`. |
| `src/lib/catalog/queries.ts` | Remove `upsertCatalogItem`, `setBureauProductCost`, `listBureauCosts`. `listCatalog` lê `products` + `current_product_price` e filtra bloqueados. Novo `getEffectiveCommission`. |
| `src/components/superadmin/bureau-costs-panel.tsx` (+ `.test.ts`) | Sai. |
| `src/app/(dashboard)/afiliados/page.tsx`, `src/components/affiliates/bureau-affiliates-table.tsx` | Somente leitura: mostra a % de afiliados do Bureau e a lista de afiliados sem coluna de % própria. Guard `affiliates:read`. |
| `src/actions/affiliates-bureau.ts` | Vira `src/actions/affiliates-superadmin.ts` com uma action só: `setBureauAffiliatePctAction(bureauId, pct)`. `setAffiliatePctAction` sai. |
| `src/lib/affiliates/rates.ts` | `setBureauDefaultPct` recebe `bureauId` explícito. `setAffiliatePct` sai. `listBureauAffiliates` deixa de ler `affiliate_rates`. |
| `src/app/(dashboard)/dossiers/new/page.tsx` | Troca `e.item?.salePrice` pelo preço da plataforma. |
| `src/lib/catalog/build-quote.ts`, `quote.ts` | `QuoteLine` perde `unitCostCents`/`costCents`. `Quote` ganha `bureauCommissionCents` e `platformShareCents` (vai como `p_cost`). `QuoteTerms` perde custo. |
| `src/lib/settlement/*`, `src/actions/orders-client.ts`, `src/components/orders/order-rules.ts` | Seguem o novo `Quote`. O portal continua lendo `public_bureau_catalog` (assinatura igual). |

Novo (telas do superadmin, onde ele define tudo):

| Arquivo | Conteúdo |
|---|---|
| `src/app/(superadmin)/superadmin/products/[id]/page.tsx`, `products/new/page.tsx`, `src/components/superadmin/product-form.tsx`, `product-version-form.tsx` | Campos "Preço de venda" e "Preço por sócio" (só Empresarial). Produto sem preço mostra "Não à venda: defina o preço". |
| `src/app/(superadmin)/superadmin/settings/comissao/page.tsx` + `src/components/settings/commission-form.tsx` | % global do Bureau (molde `payable-retention-form.tsx`). Aviso "Sem % definida: nenhuma venda é aceita". Entra em `SECTIONS` de `settings/page.tsx`. |
| `src/components/superadmin/bureau-commission-panel.tsx` | Em `bureaus/[id]/page.tsx`, no lugar de "Custos": % efetiva e origem (global ou override), campo de override, campo da % de afiliados do Bureau, histórico. |
| `src/components/superadmin/bureau-product-blocks-panel.tsx` | Em `bureaus/[id]/page.tsx`: lista de produtos com botão Bloquear/Liberar e histórico. |
| `src/lib/validators/catalog.ts` | Schemas de preço, de % e de bloqueio. |
| `src/lib/settings/readers.ts` | `BUREAU_COMMISSION_KEY`, `readBureauCommissionPct`. |

Tela do balcão: rótulo "Repasse à plataforma" no lugar de "Custo" (`src/components/orders/` e `src/lib/counter-payments/overview.ts`, se mostrar custo).

## 6. Migração e backfill

1. Adiciona colunas e tabelas (seção 2). Nada é apagado. **Nenhum preço, % ou bloqueio é gravado.**
2. Depois do deploy, o superadmin define na interface dele: o preço de cada produto (nova versão), a % global do Bureau, os overrides e a % de afiliados de cada Bureau. Até lá: produto sem preço = não à venda; sem % global = `commission_not_configured`; sem `bureau_affiliate_settings` = afiliado a 0%.
3. Pedidos antigos: `commission_pct` nulo. `capture_order` usa o ramo antigo. Reservas abertas no deploy fecham pelo modelo antigo. Accruals, comissões e repasses gravados não mudam. Linhas de `bureau_catalog_items`, `bureau_product_costs` e `affiliate_rates` ficam para histórico.
4. Ordem de entrega: migrar, o superadmin define tudo, depois liberar as vendas. Janela sem vendas entre 1 e 2 é esperada.
5. Rollback: as colunas novas são aditivas. O código antigo não as lê. O ramo antigo do SQL continua válido.

## 7. Casos de teste

Dinheiro e arredondamento (integração SQL, `src/lib/settlement/`, `src/lib/affiliates/commission.integration.test.ts`, `src/lib/wallet/sales.integration.test.ts`):

- 400,00, 20%, 10%: accrual 80,00; comissão 40,00 (`margin` 400,00); plataforma 280,00.
- Sem afiliado: accrual 80,00; sem comissão.
- Arredondamento: 10,01 com 15% e 10% → 1,50, 1,00, plataforma 7,51; soma = 10,01.
- Teto: 10,01 com 50% e 50% → Bureau 5,01, afiliado 5,00 (`least`), plataforma 0,00.
- 0,01 com 5% → `bureau_commission` 0,00, sem accrual (`amount > 0`).
- Bureau 0%: sem accrual; balcão `cost = price`.
- Precedência: override do Bureau vale mais que o global; override nulo volta ao global; global ausente → `commission_not_configured` e nada é gravado.
- Afiliado: a comissão nova usa só `bureau_affiliate_settings.default_pct`; uma linha de `affiliate_rates` existente é ignorada.
- Pedido antigo (`commission_pct` nulo) captura pelo ramo antigo (accrual = margem − comissão, com `affiliate_rates`).
- Snapshot: mudar preço, global, override e % de afiliados depois da reserva não muda o pedido nem a comissão gravada.
- `reserve_order`: `price_mismatch` e `cost_mismatch` do balcão com os valores novos; produto sem preço → `quote_mismatch`; `dossie_pf` com preço por sócio recusado.
- Bloqueio: produto bloqueado → `open_order` devolve `product_not_for_sale`, `reserve_order` devolve `quote_mismatch` e o catálogo público não o lista; liberar volta a vender; outro Bureau não é afetado; pedido já reservado captura mesmo bloqueado depois.
- Balcão: debita `price − bureau_commission` da carteira; sem accrual; sem comissão.
- Estorno de recarga: comissão pendente é revertida primeiro e o clawback continua (testes existentes de `commission.integration.test.ts` com os valores novos; SQL do estorno sem mudança).
- Guarda 100%: gravar % global, override ou % de afiliados que passe de 100 com o outro lado é recusado e desfeito.

Permissões e RLS:

- `bureau_admin` não insere nem atualiza `bureau_catalog_items`, `bureau_product_costs`, `affiliate_rates`, `bureau_affiliate_settings`, `bureau_commission_rates` nem `bureau_product_blocks`.
- Superadmin em sessão de suporte não escreve override, bloqueio nem % de afiliados.
- `operator` e `client` não escrevem nada disto. O cliente não lê `cost`, `commission_pct`, override nem bloqueio.
- `hasPermission`: `bureau_admin` sem `catalog:write` e `affiliates:manage`; superadmin com `affiliates:manage`.
- Cada escrita grava o evento de auditoria na mesma transação; metadata sem documento.

Unidade e UI: `build-quote` (sem custo), validadores de preço e %, `reference-prices`, telas somente leitura sem campos, formulário de preço do superadmin, painel de bloqueio.

## 8. Plano

Seis tarefas. Cada uma tem testes próprios. Sem tarefa de revisão: revisão única por issue (`/code-review`).

### T1. Banco: migration 048 (`database-architect`, sonnet)

- Files: `db/migrations/048_platform_pricing_commission.sql`, `src/test/seed.ts`, `src/lib/settlement/*.integration.test.ts`, `src/lib/affiliates/commission.integration.test.ts`, `src/lib/wallet/sales.integration.test.ts`, `src/lib/counter-payments/queries.integration.test.ts`, `src/lib/payables/queries.integration.test.ts`.
- Depends-on: nenhuma.
- Contrato: seções 2, 3.1, 3.2, 4 (RLS, políticas, audit; `current_product_price`, `resolve_bureau_commission_pct`, `product_blocked_for_bureau`, `public_bureau_catalog`, `open_order`, `reserve_order`, `capture_order`; tabelas `bureau_commission_rates` e `bureau_product_blocks`). Sem backfill de preço, % ou bloqueio. `seedOrderCatalog` do teste grava versão com preço e a chave global (só nos testes).
- Testes: seção 7, itens de dinheiro, snapshot, pedido antigo, bloqueio, RLS e estorno.

### T2. Backend: preço, % global, override, bloqueio e orçamento (`backend-specialist`, sonnet)

- Files: `src/lib/catalog/{queries,quote,build-quote,money}.ts`, `src/lib/catalog/*.test.ts`, `src/lib/settlement/{types,queries}.ts`, `src/lib/settings/readers.ts`, `src/lib/validators/catalog.ts`, `src/actions/{catalog,settings,orders,orders-client}.ts` e testes, `src/lib/commission/` (novo: override, bloqueio e checagem `split_over_100`).
- Depends-on: T1.
- Contrato: `createProductVersion` com `salePrice` e `salePricePerPartner`; `saveBureauCommissionAction`; `setBureauCommissionOverrideAction(bureauId, pct | null)`; `setProductBlockAction(bureauId, productId, blocked)`; `Quote` com `bureauCommissionCents` e `platformShareCents`; `reserveOrder` envia `platformShareCents` como `p_cost`; motivo `commission_not_configured`; função exportada de checagem `split_over_100` usada também por T3.
- Testes: validadores, quote sem custo, actions (permissão, zod, `split_over_100`, bloqueio), auditoria.

### T3. Backend: % de afiliados sob o superadmin (`backend-specialist`, sonnet)

- Files: `src/lib/db/permissions.ts` e teste, `src/lib/affiliates/rates.ts` e teste, `src/actions/affiliates-bureau.ts` → `src/actions/affiliates-superadmin.ts` e teste.
- Depends-on: T1. Usa a checagem `split_over_100` por SQL próprio dentro da transação (sem importar T2), então roda em paralelo com T2.
- Contrato: `setBureauDefaultPct(identity, bureauId, pct)`; `setBureauAffiliatePctAction(bureauId, pct)`; `setAffiliatePct` removida. Permissões da seção 4.
- Testes: permissões por papel, `split_over_100`, auditoria com `bureau_id`.

### T4. UI do superadmin (`frontend-specialist`, sonnet)

- Files: produtos (`products/[id]/page.tsx`, `products/new/page.tsx`, `product-form.tsx`, `product-version-form.tsx`), `settings/comissao/page.tsx`, `settings/page.tsx`, `src/components/settings/commission-form.tsx`, `bureaus/[id]/page.tsx`, `bureau-commission-panel.tsx`, `bureau-product-blocks-panel.tsx`, `bureau-costs-panel.tsx` (+ teste, remover).
- Depends-on: T2, T3.
- Paralela com T5.
- Contrato: as actions de T2 e T3. Telas cobrem: preço por produto, % global, override, % de afiliados do Bureau, bloqueio por Bureau. Avisos de "sem preço" e "sem % global".
- Testes: lógica pura dos formulários (molde `product-version-form.test.ts`).

### T5. UI do Bureau e do portal (`frontend-specialist`, sonnet)

- Files: `src/app/(dashboard)/settings/catalog/page.tsx`, `src/components/settings/catalog-form.tsx` (+ teste, remover), `src/app/(dashboard)/afiliados/page.tsx`, `src/components/affiliates/bureau-affiliates-table.tsx`, `src/app/(dashboard)/dossiers/new/page.tsx`, `src/components/orders/*` (rótulo do balcão).
- Depends-on: T2, T3.
- Paralela com T4.
- Testes: `order-rules`, regras do componente somente leitura.

### T6. Docs (`documentation-writer`, haiku)

- Files: `PRODUCT.md` (papéis, catálogo, preço, afiliados, venda online e de balcão), `docs/architecture.md`, `docs/operations/affiliates.md`, `docs/operations/payments.md` (só se citar custo), nota de substituição no topo de `docs/superpowers/specs/2026-10-24-programa-de-afiliados-design.md`.
- Depends-on: T1 (contrato fechado). Paralela com T2 a T5.
- Sem testes.

Ondas: **A** = T1 e T6. **B** = T2 e T3. **C** = T4 e T5. O coordenador commita no fim de cada onda, um commit por tarefa, na ordem.

## 9. Riscos

- Reescrever `open_order` e `reserve_order` por cópia pode perder uma regra. Mitigação: o diff da migration mostra só a consulta de catálogo e o cálculo de preço; teste de integração de cada caminho.
- O Bureau pode ler `product_versions.base_cost` por SQL direto (o papel `app_runtime` é o mesmo). Na UI isso não aparece. Antes era custo dele; agora é custo interno da plataforma. Aceito nesta entrega.
- Nenhum produto vende até o superadmin definir os preços e a % global. Fazer o deploy e a configuração juntos, fora do horário de pico.
- Bureau que desativou um produto no modelo antigo passa a vender todo produto ativo do catálogo. O superadmin deve bloquear o que for preciso antes de liberar as vendas.
- `affiliate_commissions.margin` guarda a base nova (preço) e a antiga (margem). Relatórios devem usar `amount` e `pct`, nunca recalcular por `margin`.
- Clawback do estorno não muda e não é proporcional ao pedido. Decisão do dono: manter.

## 10. Perguntas abertas

Nenhuma.
