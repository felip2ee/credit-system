# Portal: saldo só em Créditos, Início enxuta, textos que cortam: Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Concentrar saldo e extrato em Créditos, enxugar a Início, cortar texto longo com "…" e explicar pesquisa, afiliação e produtos.

**Architecture:** Só interface em Server Components. Um chip de saldo cliente pequeno (olho em localStorage). Extrato novo é uma função pura (`buildStatement`) sobre `listClientLedger` + recargas já existentes. Textos dos produtos ficam em um módulo único usado por Nova pesquisa e pela página pública.

**Tech Stack:** Next 14 App Router, React, TypeScript, Tailwind, shadcn/ui, vitest, `pg`.

**Spec:** `docs/superpowers/specs/2026-10-26-portal-credits-inicio-design.md`. Mockups: `.superpowers/brainstorm/72305-1793042406/content/*.html`.

## Global Constraints

- Sem mudança de banco, migração, carteira, pedido, pagamento ou permissão.
- Textos em pt-BR, Simplified Technical English. Identificadores em inglês. Import com `@/`.
- Saldo visível só no chip do cabeçalho e em Créditos. Sem `credits:read`: sem chip.
- Texto longo: `min-w-0` + `truncate`, nunca quebra de linha em linha de lista. Exceção: o nome do Bureau em `PublicShell` continua inteiro (teste existente em `portal-header.test.ts`).
- Preço sempre do catálogo. Sem número de carência ou taxa fixo nos textos.
- Alterações locais não commitadas em `credits/page.tsx`, `ClientTopupDialog.tsx`, `PendingChargeButton.tsx`, `(dashboard)/page.tsx` e `e2e/affiliate.spec.ts`: partir delas.
- Cada implementador: não commita. Scoped tests verdes. Coordenador faz um commit por tarefa.

## Review Focus

- Titular com 60+ caracteres e sem espaços numa linha de lista: corta, sem scroll horizontal a 360 px.
- Extrato vazio: mostra estado vazio, não grupo vazio.
- `ledger.kind` desconhecido ou valor 0: linha neutra, sem sinal.
- Recarga expirada/cancelada: cinza, sem "+".
- Dois lançamentos na mesma data local (fuso America/Sao_Paulo, virada de dia): ficam no grupo certo.
- Catálogo vazio na página pública e produto com código desconhecido: sem erro.

---

### Task 1: Texto que corta em listas

**Files:** Modify `src/components/ui/list-row.tsx`, `src/components/orders/client-order-list.tsx`. Test: `src/components/ui/list-row.test.ts` (novo).
**Depends-on:** none
**Produces:** `ListRow` com título e subtítulo em uma linha cortada.

- [ ] Teste: `renderToStaticMarkup(ListRow)` com título de 60 caracteres sem espaço contém as classes `truncate` e `min-w-0` no título e no subtítulo, e não contém `break-words`.
- [ ] `ListRow`: trocar `break-words` por `truncate` em título e subtítulo; manter `min-w-0 flex-1` no contêiner.
- [ ] `client-order-list.tsx`: mesmas regras no nome do titular e no status (status não encolhe: `shrink-0`).
- [ ] Rodar: `npx vitest run src/components/ui/list-row.test.ts` (passa).

### Task 2: Cabeçalho com chip de saldo

**Files:** Modify `src/components/portal/portal-header.tsx`, `src/components/portal/portal-header.test.ts`. Create `src/components/portal/balance-chip.tsx`.
**Depends-on:** none
**Produces:** `BalanceChip({ value }: { value: string }): JSX.Element` (`"use client"`).

- [ ] Ajustar testes de `PortalHeader`: com `balance: null` não há chip e não há "Saldo"; com `balance: "R$ 10,50"` o HTML contém o valor, não contém o texto "Saldo" nem "Rainha Cred" visível (o `aria-label` do link do logo continua). Manter os testes de `PublicShell`.
- [ ] `balance-chip.tsx`: link para `/portal/credits`, pílula `bg-brand-soft`, valor com `tabular-nums` e botão de olho (aria-label "Ocultar saldo"/"Mostrar saldo"). Estado oculto em `localStorage` chave `portal:balance-hidden`, lido em `useEffect` (try/catch); render inicial mostra o valor. Oculto mostra `R$ ••••`.
- [ ] `portal-header.tsx`: remover o `<span>Rainha Cred</span>` e o rótulo "Saldo"; usar `BalanceChip` à direita.
- [ ] Rodar: `npx vitest run src/components/portal/portal-header.test.ts`.

### Task 3: Extrato estilo Nubank em Créditos

**Files:** Create `src/lib/wallet/statement.ts`, `src/lib/wallet/statement.test.ts`, `src/components/credits/ClientStatement.tsx`. Modify `src/app/(portal)/portal/credits/page.tsx`, `src/components/credits/ClientBalanceCard.tsx`, `src/components/credits/client-ledger-labels.ts`. Remove `ClientLedgerTable.tsx` se ficar sem uso.
**Depends-on:** Task 1 (ListRow cortado)
**Produces:**
```ts
export type StatementTone = "in" | "out" | "neutral";
export type StatementRow = { id: string; title: string; detail: string; amount: string | null; tone: StatementTone; receiptHref?: string };
export type StatementGroup = { dateLabel: string; rows: StatementRow[] };
export function buildStatement(input: { ledger: ClientLedgerEntry[]; topups: ClientTopup[]; now?: Date }): StatementGroup[];
```
(`ClientTopup` = tipo já usado pela lista de recargas em `credits/page.tsx`; reusar, não criar.)

Regras (testar cada ramo):
- `topup` pago → título "Recarga por PIX", detalhe "HH:mm · Pago", tom `in`, `+ R$ x`. `Recibo` vira `receiptHref` quando existir.
- Recarga pendente: detalhe "Aguardando pagamento", `neutral`; expirada/cancelada: "Expirado"/"Cancelado", `neutral`, sem sinal. O botão `PendingChargeButton` continua para pendentes.
- `capture` → "Pesquisa", `out`, `− R$ x`. `reversal` → "Estorno", `in`. `commission_credit` → "Comissão convertida", `in`. `adjustment_credit`/`adjustment_debit` → "Ajuste", `in`/`out`. `reserve`/`release` e `kind` desconhecido: omitidos.
- Grupos por data local `America/Sao_Paulo`, mais recente primeiro, rótulo "26 out". Linhas do dia por hora decrescente. Pago aparece uma vez (não duplicar recarga pago + ledger `topup`: preferir a recarga, que tem recibo).
- Casos de teste: vazio → `[]`; virada de dia; `kind` desconhecido omitido; valor 0 → `neutral` sem sinal; recarga paga + ledger `topup` da mesma referência → 1 linha.
- [ ] Escrever `statement.test.ts` com esses casos e ver falhar.
- [ ] Implementar `buildStatement` até passar.
- [ ] `ClientStatement.tsx` (Server Component): títulos de grupo, `ListRow` com `value` colorido (`text-success` em `in`, cinza em `neutral`), estado vazio com `EmptyState`.
- [ ] `credits/page.tsx` e `ClientBalanceCard.tsx`: saldo + "Reservado em pedidos" (só se > 0) + Recarregar/Ver extrato; trocar a tabela por `ClientStatement`.
- [ ] Rodar: `npx vitest run src/lib/wallet` e `npm run type-check`.

### Task 4: Início enxuta

**Files:** Modify `src/app/(portal)/portal/page.tsx`.
**Depends-on:** Task 1
**Produces:** Início sem `BalanceCard`.

- [ ] Remover `BalanceCard` e a busca de `wallet`. Ordem: "Suas pesquisas" (só com pesquisas), "Afiliação" (disponível e em carência, se `affiliates:read`), "O que você pode fazer" (`QuickActions`). Sem pesquisas: "O que você pode fazer" primeiro, sem o `EmptyState` de pesquisas.
- [ ] Remover imports sem uso. Atualizar `e2e/` que procura o bloco verde ou "Créditos disponíveis" na Início.
- [ ] Rodar: `npm run type-check && npm run lint`.

### Task 5: Nova pesquisa explicada

**Files:** Create `src/lib/catalog/product-copy.ts`, `src/lib/catalog/product-copy.test.ts`, `src/components/orders/research-intro.tsx`. Modify `src/components/orders/client-order-form.tsx` (só o passo de escolha do produto), `src/app/(portal)/portal/pesquisas/nova/page.tsx` se precisar.
**Depends-on:** none
**Produces:**
```ts
export type ProductCopy = { summary: string; includes: string[] };
export function productCopy(code: string): ProductCopy | null;
```
- Códigos: `dossie_pf` (PF: dívidas e histórico no sistema financeiro, SCR; relatório em tela e PDF) e `dossie_empresarial` (CNPJ e sócios; "+ por sócio" vem do preço, não do texto). Outro código → `null`. Parecer por IA: texto opcional separado, só quando o produto oferece.
- [ ] Teste: `productCopy("dossie_pf")` e `("dossie_empresarial")` retornam `summary` não vazio; `productCopy("x")` retorna `null`.
- [ ] `research-intro.tsx` (cliente): "O que é uma pesquisa?" recolhível, começa aberto, lembra o recolhimento em `localStorage` (`portal:research-intro-closed`, try/catch). Conteúdo: o que é, o titular autoriza antes, relatório em tela e PDF com aviso por e-mail e WhatsApp, saldo só sai quando a consulta roda.
- [ ] Formulário: `ResearchIntro` no topo; em cada produto, resumo de 1 linha cortada + "O que você recebe" que expande `includes`. Produto sem copy: só nome e preço.
- [ ] Rodar: `npx vitest run src/lib/catalog && npm run type-check`.

### Task 6: Afiliação com "Como funciona"

**Files:** Create `src/components/affiliates/how-it-works.tsx`. Modify `src/app/(portal)/portal/afiliacao/page.tsx`.
**Depends-on:** none
**Produces:** `HowItWorks({ fee }: { fee: { fixed: string; percent: string } | null })`.

- [ ] 5 passos do spec, no topo da página, recolhível (`<details open>`). Passo 5 cita a taxa só quando `fee` existe ("com taxa de R$ x + y%"); senão "com taxa". Carência: "alguns dias" (sem número). Nota: pedido estornado desfaz a comissão.
- [ ] Ligar em `afiliacao/page.tsx` acima do cartão de link, passando `fee`.
- [ ] Rodar: `npm run type-check && npm run lint`.

### Task 7: Página pública explicada

**Files:** Modify `src/app/b/[slug]/page.tsx`. Create `src/components/portal/public-how-it-works.tsx`.
**Depends-on:** Task 5 (`productCopy`)
**Produces:** página com promessa, "Qual dossiê escolher", "Como funciona" (4 passos), dúvidas e CTA.

- [ ] Ordem do spec: hero curto + "Criar conta"; cartões de produto (nome cortado, preço do catálogo incl. "por sócio", `productCopy`); parecer por IA opcional; 4 passos; 3 dúvidas em `<details>`; "Criar conta" no fim e fixo embaixo (`sticky bottom-0`), "Já tenho conta: entrar". Catálogo vazio: "Catálogo em breve" e o resto segue.
- [ ] Manter `dynamic = "force-dynamic"`, `metadata.title = "Rainha Cred"`, `notFound()` e `getPublicBureau`/`getPublicCatalog`. Links `/b/${slug}/cadastro` e `/login`.
- [ ] Rodar: `npm run type-check && npm run lint`.

### Task 8: Docs e e2e

**Files:** Modify `docs/design.md`, `e2e/*.spec.ts` afetados, `e2e/affiliate.spec.ts` (já alterado).
**Depends-on:** Tasks 2-7

- [ ] `docs/design.md`: regras novas (saldo só em Créditos e no chip; texto de lista corta com "…"; extrato por data; explicações de pesquisa, afiliação e página pública).
- [ ] Ajustar seletores de e2e que usam "Saldo", "Créditos disponíveis" ou a tabela do extrato.
- [ ] Rodar: `npm run check`. Rodar e2e do portal se o ambiente permitir; senão registrar como não executado.

---

## Waves

1. Wave 1 (paralelo, arquivos disjuntos): Tasks 1, 2, 5, 6.
2. Wave 2 (paralelo): Tasks 3, 4, 7 (dependem de 1 ou 5).
3. Wave 3: Task 8.

Implementadores: `frontend-specialist`, modelo `sonnet`. Review uma vez no fim da entrega (`/code-review`, `code-reviewer` + `security-reviewer`).

## Pós-deploy

- Conferir no celular real a 360 px: chip, extrato e página pública.
