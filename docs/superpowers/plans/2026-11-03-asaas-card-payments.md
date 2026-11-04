# Pagamento com cartão via Asaas — plano de implementação

> **Para agentes:** use `superpowers:subagent-driven-development`. Siga a seção "Lean delivery" do `CLAUDE.md`: ondas paralelas, sem revisão por tarefa, implementadores não fazem commit.

**Meta:** cartão de crédito (à vista e até 12x) nas duas recargas de carteira que hoje só aceitam Pix.

**Arquitetura:** nova cobrança `card_charges` ao lado de `pix_charges`. O crédito continua só no webhook, via `apply_asaas_payment`, com regra de crédito único por parcelamento. A taxa vem de uma tabela de configuração e é repassada ao cliente por um módulo puro.

**Stack:** Next.js 14, `pg` sem ORM, zod, shadcn/ui, Asaas v3.

**Spec:** `docs/superpowers/specs/2026-11-03-asaas-card-payments-design.md`

## Restrições globais

- Máximo 12 parcelas. Taxas provisórias: 1x 2,99% + R$ 0,49; 2–6x 3,49% + R$ 0,49; 7–12x 3,99% + R$ 0,49. Tudo em configuração, nunca fixo no código.
- Total cobrado = (recarga + taxa fixa) / (1 − taxa%), arredondado para cima ao centavo. Parcelas iguais, resto na última. O saldo sobe pela recarga, não pelo total.
- Nunca gravar nem logar número, CVV, validade, corpo da requisição ou CPF/CNPJ completo. No banco: id Asaas, id do parcelamento, bandeira, 4 últimos dígitos, parcelas, taxa, total.
- Crédito só pelo webhook, no primeiro `PAYMENT_CONFIRMED` do parcelamento. Estorno de qualquer parcela reverte o crédito inteiro.
- Padrões do projeto: `withUserTransaction`, SQL parametrizado, zod, evento de auditoria na mesma transação, retorno `{ error: string | null, id? }`, textos de UI em pt-BR, migration só nova (`040` em diante; `038` e `039` já existem).

## Foco de revisão

- Webhook de parcela 2..N chega depois do crédito: não credita de novo e não vira `unknown_charge` com erro.
- Webhook chega antes de `bind`: a linha reservada casa por `externalReference`.
- Clique duplo ou reenvio: uma só cobrança no Asaas.
- Cartão recusado (HTTP 400): nenhuma linha órfã e nenhum crédito.
- Arredondamento: líquido do Asaas = recarga em todos os valores de centavo nas 3 faixas.

## Ondas

- Onda 1 (paralela): Tarefas 1, 2, 3, 7.
- Onda 2: Tarefa 4.
- Onda 3: Tarefa 5.
- Onda 4: Tarefa 6.

---

### Tarefa 1: Taxas e configuração

**Agente:** `backend-specialist`, `sonnet`.
**Files:** criar `src/lib/wallet/card-fees.ts`, `src/lib/wallet/card-fees.test.ts`; alterar `src/lib/config.ts`, `src/lib/config.test.ts`, `.env.example`.
**Depends-on:** none.

**Contrato:**
- `computeCardCharge(input: { rechargeCents: number; installments: number }): { totalCents: number; feeCents: number; installmentCents: number[] }`. Erro tipado se `installments` fora de 1..12 ou parcela abaixo do mínimo.
- `listInstallmentOptions(rechargeCents: number): Array<{ installments: number; totalCents: number; installmentCents: number }>` só com planos válidos (esconde os abaixo do mínimo).
- Configuração: tabela de faixas (`maxInstallments`, `percent`, `fixedCents`) e parcela mínima. Valores provisórios das restrições globais. Parcela mínima: confirmar na documentação Asaas; sem confirmação, usar R$ 5,00 como provisório e marcar `(post-deploy)`.

**Testes (dinheiro):** 1x, 6x, 7x, 12x; recarga que gera dízima; soma das parcelas = total; líquido = recarga após aplicar a taxa; 13x rejeitado; parcela mínima esconde planos.

### Tarefa 2: Banco e webhook

**Agente:** `database-architect`, `sonnet`.
**Files:** criar `db/migrations/040_card_charges.sql`, `db/migrations/041_apply_asaas_payment_card.sql`, `src/lib/wallet/card-charges.integration.test.ts`; alterar `src/app/api/webhooks/asaas/route.test.ts` (e `route.ts` só se o teste provar que precisa).
**Depends-on:** none.

**Contrato:**
- Tabela `card_charges`: id, bureau_id, client_profile_id (nulo no bureau), asaas_payment_id (nulo até bind), asaas_installment_id, external_reference único, recharge_cents, fee_cents, total_cents, installments, brand, last4, status (`pending|paid|failed|refunded`), idempotency_key único por usuário, requested_by, created_at. RLS e grants no mesmo padrão de `pix_charges` (012/013/014).
- Nova versão de `apply_asaas_payment` (nova migration, sem editar a 027): para cartão, casa por `asaas_payment_id` ou `asaas_installment_id`; credita uma vez no primeiro `PAYMENT_CONFIRMED`; eventos seguintes do mesmo parcelamento retornam `duplicate`; `PAYMENT_REFUNDED` de qualquer parcela reverte o crédito inteiro uma vez. Caminho Pix inalterado.
- Função SQL `bind_card_charge(...)` análoga a `bind_pix_charge`.

**Testes (integração, Postgres):** crédito único em N=3 eventos; estorno reverte uma vez; comissão de afiliado reverte como no Pix; evento de parcela sem linha → `unknown_charge`; teste do webhook com payload de parcelamento.

### Tarefa 3: Cliente Asaas

**Agente:** `backend-specialist`, `sonnet`.
**Files:** alterar `src/lib/asaas/types.ts`, `client.ts`, `fake.ts`, `asaas.test.ts`.
**Depends-on:** none.

**Contrato:**
- `createCardCharge(input: CardChargeInput): Promise<CardChargeResult>`. Input: `externalReference`, `totalCents`, `installments`, dados do cartão, `holder` (nome, CPF/CNPJ, e-mail, CEP, telefone), `remoteIp`. POST `/v3/payments` com `billingType: "CREDIT_CARD"`; `installmentCount` e `totalValue` só se `installments >= 2`.
- Result: `{ asaasPaymentId, asaasInstallmentId: string | null, brand, last4 }`. HTTP 400 vira erro tipado `CardDeclinedError` com mensagem segura (sem dados do cartão).
- O fake aceita um cartão de teste aprovado e um recusado e gera eventos com `installment` id (`buildFakePaymentEvent` estendido).
- Confirmar na documentação Asaas se `remoteIp` e `creditCardHolderInfo` são obrigatórios. Nenhum log do corpo da requisição.

**Testes:** payload à vista sem campos de parcela; payload 3x com campos de parcela; recusa vira `CardDeclinedError`; teste com spy em `console` provando que número e CVV nunca aparecem em saída ou em erro.

### Tarefa 4: Consultas de carteira

**Agente:** `backend-specialist`, `sonnet`.
**Files:** criar `src/lib/wallet/card-charges.ts`; alterar `src/lib/wallet/card-charges.integration.test.ts` (criado na Tarefa 2; esta tarefa só acrescenta casos).
**Depends-on:** 1, 2, 3.

**Contrato:** `reserveCardCharge(ctx, input)` (idempotente pela chave; reserva antes de chamar o Asaas), `bindCardCharge(ctx, id, result)`, `failCardCharge(ctx, id)`, `getCardChargeStatus(ctx, id): { status; credited: boolean }`. Cada uma usa `withUserTransaction`, devolve `{ ok: false, reason }` para conflito e grava auditoria sem dados de cartão.

**Testes (integração):** mesma chave devolve a mesma linha; falha libera a linha como `failed`; isolamento entre bureaus.

### Tarefa 5: Server Actions

**Agente:** `backend-specialist`, `sonnet`.
**Files:** criar `src/lib/validators/card-topup.ts`; alterar `src/actions/wallet-topup.ts`, `src/actions/credits-topup.ts`, `src/actions/wallet-topup.test.ts`, `src/actions/credits-topup.test.ts`.
**Depends-on:** 1, 4.

**Contrato:** `requestCardTopupAction` (bureau) e `requestClientCardTopupAction` (portal). Ordem: zod `safeParse` → sessão → `hasPermission` (mesma permissão da recarga Pix) → `computeCardCharge` no servidor (nunca confiar no total vindo do cliente) → `reserveCardCharge` → `createCardCharge` → `bindCardCharge` → `revalidatePath`. Retorno `{ error: string | null, id? }`. `remoteIp` vem dos cabeçalhos do servidor. Limite de tentativas por usuário: reaproveitar o mecanismo de rate limit do projeto; se não existir, limite simples em `card_charges` por janela de tempo. Action de leitura `getCardChargeStatusAction(id)` para o polling.

**Testes:** total do cliente adulterado é ignorado; recusa não deixa crédito; mesma chave não cobra duas vezes; usuário sem permissão rejeitado; rate limit; spy provando ausência de dados de cartão em log e auditoria.

### Tarefa 6: Interface

**Agente:** `frontend-specialist`, `sonnet`.
**Files:** criar `src/components/wallet/CardPaymentForm.tsx`, `src/components/wallet/InstallmentSelect.tsx`; alterar `src/components/wallet/TopupDialog.tsx`, `src/components/credits/ClientTopupDialog.tsx`.
**Depends-on:** 1, 5.

**Contrato:** seletor Pix/Cartão nos dois diálogos. Formulário de cartão (campos com `autocomplete` correto, sem armazenar em estado global nem em `localStorage`), dados do pagador (portal: digitados a cada compra; bureau: dados do dono), seletor de parcelas mostrando total e valor da parcela via `listInstallmentOptions`. Após confirmar: estado "processando" com consulta de status a cada poucos segundos por até 60 s, depois "pagamento em análise; o saldo atualiza sozinho". Botão travado durante o envio; chave de idempotência gerada por envio. Textos em pt-BR. Skills: `/ui-ux-pro-max`, `/vercel:shadcn`.

**Testes:** estados de renderização (planos escondidos abaixo do mínimo, processando, recusado, aprovado) e acessibilidade dos campos. Navegação real com Playwright MCP contra o driver fake.

### Tarefa 7: Resumo do pedido (Total e Saldo disponível)

**Agente:** `frontend-specialist`, `sonnet`.
**Files:** alterar `src/components/orders/client-order-form.tsx` (linhas ~300-320: blocos "Total" e "Saldo disponível"; o aviso "Saldo insuficiente" fica logo abaixo).
**Depends-on:** none. Não depende do cartão.

**Contrato:** "Total" e "Saldo disponível" ficam em linhas separadas, uma abaixo da outra, cada uma com rótulo à esquerda e valor à direita, no mesmo estilo das linhas "Empresa" e "Sócios". Hoje as duas ficam lado a lado e os valores grandes se encostam no celular. Hierarquia: o Total mantém o destaque (fonte grande e negrito); o saldo usa peso menor. O aviso de saldo insuficiente não muda de texto. Sem quebra de layout em 360 px de largura. Mudar só o necessário. Skill: `/ui-ux-pro-max`.

**Teste:** checar com Playwright MCP em 360 px e em desktop, com e sem saldo suficiente. Se já existir teste do componente ou e2e do pedido (`e2e/portal-order.spec.ts`), ele continua verde.

---

## Fora do plano (sem tarefa)

- Documentação (`PRODUCT.md`, `docs/architecture.md`, runbook em `docs/operations/`, `.env.example`): despachar direto a `documentation-writer` (haiku) depois da Onda 4.
- Revisão: uma só, ao fechar a issue (`/code-review`, `code-reviewer` + `security-reviewer`, com foco em dinheiro e dados de cartão).

## Acompanhamento pós-deploy

- Conferir as taxas reais (2–6x, 7–12x, taxa fixa por faixa) no painel Asaas e ajustar a configuração.
- Confirmar que a conta Asaas permite envio direto de dados de cartão.
- Confirmar a parcela mínima e o comportamento real dos webhooks de parcelamento em produção.
- Job de reconciliação para aprovação sem webhook: avaliar depois, se ocorrer.
