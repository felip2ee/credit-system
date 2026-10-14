# M2 — Catálogo e preços: Desenho

**Data:** 2026-10-14
**Status:** rascunho (aguarda aprovação das decisões 1–10)
**Milestone:** M2 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)
**Issues:** #22, #23, #24, #25
**Depende de:** [M1](2026-10-14-m1-multitenant-design.md) (Bureau, papéis, RLS por tenant, `/b/<slug>`)

## Objetivo

O superadmin cadastra os produtos base e o custo de cada um. Cada Bureau escolhe quais produtos vende e define o preço de venda. O Parecer IA é um adicional com preço próprio. A página `/b/<slug>` lista o catálogo do Bureau.

O M2 define e valida preço e custo. O M2 não cobra nada: pedido, reserva e lançamento chegam no M3 e no M6.

## Ponto de partida

- `dossiers.product` e `consultations.product` guardam o nome DEPS como texto.
- `src/lib/deps/products.ts` é a fonte única dos nomes `Smart PF 002` e `Smart PJ 010`. As variáveis `DEPS_PRODUTO_PF` e `DEPS_PRODUTO_PJ` sobrescrevem esses nomes.
- `settings` é o modelo de tabela global: leitura por staff, escrita só pelo superadmin.
- `audit_logs.bureau_id` aceita nulo para eventos da plataforma.
- `/b/<slug>` mostra só o nome do Bureau (critério de #21 adiado para o M2).
- Não existem tabelas, permissões nem telas de catálogo.

## Decisões

1. **Nomes em inglês.** Tabelas: `products`, `product_versions`, `bureau_product_costs`, `bureau_catalog_items`. A interface usa pt-BR: Produtos, Custo, Preço de venda, Catálogo.
2. **Produto base.** `products(id, code, name, kind, addon_for, active)`.
   - `code` é único e estável: `consulta_pf`, `consulta_pj`, `dossie_pj_completo`, `parecer_ia`.
   - `kind` é `main` ou `addon`.
   - `addon_for` lista os `code` de produtos `main` aceitos. Só vale para `addon`. O Parecer IA aceita os três produtos `main`.
   - Produto desativado não aparece em novos catálogos. Pedidos antigos continuam válidos.
3. **Versão do produto.** `product_versions(id, product_id, version, deps_product, base_cost, created_by, created_at)`, imutável (sem UPDATE nem DELETE, nem pelo superadmin).
   - `deps_product` é o nome do produto DEPS (mapeamento do #22). Produto `addon` sem chamada própria à DEPS tem `deps_product` nulo.
   - `base_cost` é o custo padrão (#23).
   - A versão vigente é a de maior `version`. Mudar `deps_product` ou `base_cost` cria uma versão nova.
   - O M3/M6 grava no pedido o `product_version_id` e os valores resolvidos. Assim o preço vigente no momento do pedido não muda depois (#22).
4. **Custo por Bureau.** `bureau_product_costs(id, bureau_id, product_id, cost, set_by, created_at)`, só INSERT. A linha mais recente do par (Bureau, produto) é o override vigente. O custo efetivo é o override vigente, ou `base_cost` da versão vigente se não houver override. A tabela é o histórico do #23; cada INSERT também grava um evento de auditoria.
5. **Item de catálogo do Bureau.** `bureau_catalog_items(bureau_id, product_id, active, sale_price, updated_by, updated_at)`, chave `(bureau_id, product_id)`. A mudança de preço grava auditoria com valor antigo e novo.
6. **Regra de preço.** `sale_price >= custo efetivo`, vale para produto `main` e para `addon`. A query valida dentro da transação, com `select … for update` no item. Uma trigger repete a checagem no INSERT/UPDATE de `bureau_catalog_items` (falha fechada no SQL).
7. **Custo sobe acima do preço.** O sistema não altera o preço do Bureau. O item fica **à venda** só se `active and sale_price >= custo efetivo`. Se o custo passa o preço, o item sai de `/b/<slug>` e do pedido, e a tela do admin mostra "Preço abaixo do custo". O admin reajusta o preço para voltar à venda.
8. **Adicional Parecer IA (#25).** Um adicional só entra em um catálogo se o Bureau vende ao menos um produto `main` listado em `addon_for`. Desativar o último produto `main` compatível tira o adicional da venda. O M2 expõe `quoteOrder(bureauId, productCode, { withAi })`. Ela devolve custo total, preço total e `product_version_id` de cada linha. O M3 cobra o custo do Bureau com esse resultado. O M6 liga a função ao pedido.
9. **Permissões.** Duas novas: `catalog:read` e `catalog:write`.
   - `superadmin`: `catalog:read`, `catalog:write` (produtos base, versões, custo por Bureau).
   - `bureau_admin`: `catalog:read`, `catalog:write` (só itens do próprio catálogo).
   - `operator`: `catalog:read`.
   - `client`: nenhuma. O cliente vê o catálogo só pela página pública.
   - `catalog:write` do `bureau_admin` não permite ler nem gravar produto base, versão ou custo. A diferença fica nas políticas RLS e nas actions: o admin grava só `bureau_catalog_items`.
10. **Acesso ao banco.**
    - `products` e `product_versions` são globais, como `settings`. Leem `superadmin`, `bureau_admin` e `operator`. Grava só o `superadmin`.
    - `bureau_catalog_items` e `bureau_product_costs` têm `bureau_id not null`, FK composta e a política de tenant do M1.
    - **Exceção ao M1:** o superadmin lê e insere `bureau_product_costs` sem sessão de suporte, para qualquer Bureau. Custo não é dado pessoal. Nenhuma outra tabela de tenant ganha essa exceção.
    - O `bureau_admin` lê o custo efetivo do próprio Bureau (precisa dele para validar o preço). Não grava custo.
    - Auditoria de custo usa o `bureau_id` do Bureau alvo, mesmo com o superadmin fora de suporte. O helper de auditoria precisa aceitar esse `bureau_id` explícito (ver Riscos).
11. **Página pública.** A função SECURITY DEFINER `public_bureau_catalog(slug text)` devolve só `code`, `name`, `kind` e `sale_price` dos itens à venda de um Bureau ativo. Nunca devolve custo, `deps_product` nem ids internos. Slug inexistente ou inativo devolve zero linhas e a página mantém o 404 do M1. Sem itens à venda, a página mostra "Catálogo em breve".
12. **Dinheiro.** Colunas `numeric(15,2)`, reais. Em TypeScript, os valores trafegam como string decimal e a comparação usa centavos inteiros. Nunca `number` de ponto flutuante. Preço e custo: `> 0` e `<= 99999999.99`.
13. **Não religar o fluxo atual à tabela.** `depsProductName()` e as variáveis `DEPS_PRODUTO_*` continuam como estão. O M2 só grava o mapeamento. O M6 troca a fonte para `product_versions.deps_product`. Até lá, o seed repete os dois nomes de `src/lib/deps/products.ts`; um teste compara os dois para detectar divergência.
14. **Seed.** A migration cria quatro produtos e a versão 1 de cada um. `base_cost` do seed é `0.00` e o superadmin ajusta antes de vender. Um item só fica à venda com custo efetivo maior que zero.

## Modelo de dados

| Tabela | Escopo | Pontos-chave |
|---|---|---|
| `products` | global | `code` único; `kind main/addon`; `addon_for text[]`; CHECK: `addon_for` só em `addon` e não vazio |
| `product_versions` | global | `unique (product_id, version)`; trigger bloqueia UPDATE e DELETE; `base_cost numeric(15,2) >= 0` |
| `bureau_product_costs` | tenant | só INSERT; `cost numeric(15,2) > 0`; FK composta para `bureaus`; índice `(bureau_id, product_id, created_at desc)` |
| `bureau_catalog_items` | tenant | PK `(bureau_id, product_id)`; `sale_price numeric(15,2) > 0`; trigger da regra de preço |
| `public_bureau_catalog(slug)` | função | SECURITY DEFINER; só itens à venda |
| `resolve_product_terms(bureau_id, product_id)` | função | devolve `product_version_id`, custo efetivo e preço; base de `quoteOrder` |

## Telas

| Rota | Quem | Conteúdo |
|---|---|---|
| `/superadmin/products` | superadmin | lista de produtos base; criar; editar nome e estado; nova versão (mapeamento DEPS e custo padrão) |
| `/superadmin/bureaus/<id>` | superadmin | seção "Custos": custo efetivo por produto, override, histórico |
| `/settings/catalog` | bureau_admin | produtos disponíveis; ativar ou desativar; preço de venda; custo efetivo; aviso "Preço abaixo do custo" |
| `/b/<slug>` | público | lista de produtos e preços, ou "Catálogo em breve" |

O operador vê o catálogo em leitura (`catalog:read`) na mesma rota `/settings/catalog`, sem os controles de gravação.

## Fora do escopo

- Pedido, reserva, captura, estorno e livro-razão (M3, M6).
- Cobrança do custo do Bureau (M3). O M2 só entrega o `quoteOrder`.
- Troca de `depsProductName()` pela tabela (M6).
- Cadastro e compra do cliente em `/b/<slug>` (M5, M6).
- Preço por faixa de volume, cupom, desconto e moeda diferente de BRL.
- Agendar custo ou preço para data futura.

## Critérios de pronto

Cada critério aponta para o teste que o prova.

- O superadmin cria produto, edita e cria nova versão com mapeamento DEPS e custo; a versão antiga não muda (Task 1, 2).
- UPDATE e DELETE em `product_versions` falham, inclusive para o dono da tabela via role da aplicação (Task 1).
- O custo efetivo é o override vigente, ou o custo padrão da versão vigente sem override (Task 2).
- Cada mudança de custo cria uma linha em `bureau_product_costs` e um evento de auditoria com valor antigo e novo (Task 2).
- O superadmin lê e grava custo de qualquer Bureau sem sessão de suporte. Esse mesmo superadmin lê zero linhas de `bureau_catalog_items`, `holders` e das demais tabelas de tenant (Task 1).
- O `bureau_admin` do Bureau A não lê nem grava item, custo ou preço do Bureau B (Task 1).
- Preço menor que o custo efetivo é rejeitado na query e na trigger (Task 1, 2).
- Custo que sobe acima do preço tira o item de `public_bureau_catalog` sem alterar `sale_price` (Task 2).
- O Parecer IA só entra no catálogo com um produto `main` compatível ativo, e sai quando o último compatível sai (Task 2).
- `quoteOrder` soma custo e preço do produto e do adicional, com as versões vigentes (Task 2).
- O `operator` lê o catálogo e não grava (Task 2).
- `public_bureau_catalog` não devolve custo nem `deps_product`, e devolve zero linhas para Bureau inativo ou inexistente (Task 1).
- `/b/<slug>` mostra os itens à venda e "Catálogo em breve" quando não há (Task 4).
- O seed e `src/lib/deps/products.ts` concordam nos nomes DEPS (Task 2).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da última onda.
- (post-deploy) O superadmin define o custo real de cada produto no Bureau de produção antes de abrir vendas.

## Riscos

- O helper de auditoria usa o `bureau_id` do contexto. O superadmin fora de suporte não tem `bureau_id`. A Task 2 ajusta o helper para aceitar `bureau_id` explícito só neste caso e testa que um operador não consegue passar esse valor.
- A exceção da decisão 10 amplia o acesso do superadmin. A política limita a exceção a SELECT e INSERT em uma tabela sem dado pessoal. O teste de isolamento da Task 1 cobre as demais tabelas.
- Dois lugares guardam o nome DEPS até o M6 (seed e `products.ts`). O teste da decisão 13 evita divergência silenciosa.
- Erro de arredondamento em dinheiro: a comparação em centavos inteiros e o `numeric(15,2)` evitam o problema; a Task 2 testa `0.10 + 0.20`.

## Plano de tarefas (resumo para o plano de execução)

| Task | Agente | Conteúdo | Depende de |
|---|---|---|---|
| 1 | `database-architect` | `010_catalog.sql`: tabelas, triggers, RLS, funções, seed; testes de isolamento e imutabilidade | — |
| 2 | `backend-specialist` | `src/lib/catalog/`, permissões `catalog:*`, ajuste do helper de auditoria, actions, `quoteOrder`; testes | 1 |
| 3 | `frontend-specialist` | telas do superadmin (`/superadmin/products`, seção "Custos") | 2 |
| 4 | `frontend-specialist` | `/settings/catalog` e listagem em `/b/<slug>` | 2 |

Ondas: 1 → 2 → (3, 4 em paralelo, arquivos disjuntos). Review uma vez, no fim, sobre o diff inteiro do M2.
