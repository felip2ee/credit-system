# M3a — Carteira do Bureau e recarga PIX: Desenho

**Data:** 2026-10-14
**Status:** rascunho (aguarda revisão do usuário)
**Milestone:** M3a, primeira metade do M3 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)
**Depende de:** [M1](2026-10-14-m1-multitenant-design.md) (Bureau, papéis, RLS por tenant) e [M2](2026-10-14-m2-catalogo-precos-design.md) (`quoteOrder`)

## Objetivo

Cada Bureau tem uma carteira pré-paga. O admin do Bureau recarrega o saldo por PIX (Asaas). O saldo só muda por lançamento imutável no livro-razão. O M6 usa `reserve`, `capture` e `release` para cobrar o custo da consulta.

## Escopo

Dentro:
- Livro-razão imutável e carteira do Bureau.
- Recarga por PIX via Asaas e webhook de pagamento.
- Ajuste manual do superadmin, com motivo.
- Telas de saldo e extrato.

Fora (M3b e M6):
- Cartão e chargeback.
- Crédito do cliente final, NFS-e, extrato de repasse.
- Pedido de pesquisa. O M3a entrega as funções; o M6 as chama.

## Decisões

1. **Nomes em inglês.** Tabelas: `wallets`, `ledger_entries`, `pix_charges`, `asaas_webhook_events`. A interface usa pt-BR: Carteira, Saldo, Extrato, Recarregar.
2. **Ledger com saldo materializado.** `wallets(bureau_id, available, reserved)` guarda o saldo. `ledger_entries` guarda a verdade. Cada mutação trava a linha da carteira (`select … for update`), insere o lançamento e atualiza o saldo na mesma transação.
3. **Lançamento imutável.** `ledger_entries(id, bureau_id, kind, amount, available_after, reserved_after, idempotency_key, reference, reason, created_by, created_at)`. Trigger bloqueia UPDATE e DELETE. `idempotency_key` é única por Bureau.
4. **Tipos de lançamento.**
   - `topup`: soma em `available`.
   - `reserve`: move de `available` para `reserved`.
   - `capture`: baixa de `reserved`.
   - `release`: move de `reserved` para `available`.
   - `adjustment`: soma ou subtrai `available`; exige `reason`; só o superadmin.
5. **Saldo nunca fica negativo.** CHECK `available >= 0 and reserved >= 0`. `reserve` sem saldo devolve `{ ok: false, reason: "insufficient_balance" }`. `capture` e `release` acima do reservado devolvem `{ ok: false, reason: "reservation_exceeded" }`.
6. **Idempotência.** Repetir uma chamada com a mesma `idempotency_key` devolve o lançamento original e não altera o saldo.
7. **Dinheiro.** `numeric(15,2)`, reais. Em TypeScript: string decimal na borda e centavos inteiros no cálculo. Nunca `number` de ponto flutuante (regra do M2).
8. **Recarga PIX.** `pix_charges(id, bureau_id, asaas_payment_id, amount, status, pix_payload, expires_at, requested_by, created_at)`.
   - Valor mínimo R$ 10,00 e máximo R$ 5.000,00 por cobrança.
   - A cobrança PIX expira em 30 minutos na interface. O Asaas recebe só `dueDate` (sem expiração por minuto): um PIX pago após esse prazo ainda é creditado.
   - Status: `pending`, `paid`, `expired`, `cancelled`, `refunded`.
9. **Adaptador Asaas.** `src/lib/asaas/` expõe `createPixCharge` e `getPixQrCode`. Existe uma implementação real e um fake para teste. A escolha vem de configuração, sem fallback silencioso: sem chave configurada, a recarga falha com erro claro.
10. **Webhook.** Rota `api/webhooks/asaas`.
    - Valida o token do header contra o segredo configurado (comparação em tempo constante). Token inválido: 401, nada é gravado.
    - Grava o evento bruto em `asaas_webhook_events`, com `event_id` único.
    - Evento repetido: responde 200 e não credita de novo.
    - `PAYMENT_RECEIVED` ou `PAYMENT_CONFIRMED` de uma `pix_charges` pendente: marca `paid` e cria o `topup`, na mesma transação. O valor creditado vem do registro local, nunca do corpo do webhook.
    - Evento de uma cobrança desconhecida: grava e responde 200, sem creditar.
    - Cobrança já `expired` que receba pagamento: o webhook credita mesmo assim, e a tela de expirado avisa isso.
11. **Permissões.** Três novas: `wallet:read`, `wallet:topup`, `wallet:adjust`.
    - `superadmin`: `wallet:read` e `wallet:adjust` (qualquer Bureau, sem sessão de suporte para o saldo; a política limita-se a `wallets` e `ledger_entries`).
    - `bureau_admin`: `wallet:read`, `wallet:topup`.
    - `operator`: `wallet:read`.
    - `client`: nenhuma.
12. **Acesso ao banco.** As quatro tabelas têm `bureau_id not null`, FK composta e a política de tenant do M1. `ledger_entries` aceita só INSERT. A rota do webhook roda sem sessão de usuário: usa uma função `SECURITY DEFINER` única, `apply_asaas_payment(...)`, que faz a transação do item 10. A role da aplicação não tem INSERT direto em `ledger_entries`; só as funções da carteira o fazem.
13. **Auditoria.** Cada mutação grava um evento de auditoria na mesma transação, exceto `reserve`, `capture` e `release`: para estes o próprio lançamento no ledger é o registro. O M6 acrescenta auditoria se o fluxo de pedido precisar. Nunca grava chave de API, token nem payload PIX completo.
14. **Segredos.** Chave de API e token do webhook ficam em variáveis de ambiente (`ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`). Nunca entram no repositório.

## Modelo de dados

| Tabela / função | Pontos-chave |
|---|---|
| `wallets` | PK `bureau_id`; CHECK `>= 0`; sem UPDATE direto pela role da aplicação |
| `ledger_entries` | só INSERT; trigger bloqueia UPDATE e DELETE; `unique (bureau_id, idempotency_key)` |
| `pix_charges` | `unique (asaas_payment_id)`; CHECK de valor mínimo e máximo |
| `asaas_webhook_events` | `unique (event_id)`; guarda payload bruto sem segredo |
| `wallet_apply(...)` | função SQL interna: trava a carteira, valida, insere lançamento, atualiza saldo |
| `apply_asaas_payment(...)` | `SECURITY DEFINER`; usada só pelo webhook |

## Telas

| Rota | Quem | Conteúdo |
|---|---|---|
| `/settings/wallet` | `bureau_admin` (grava), `operator` (lê) | saldo disponível e reservado; botão Recarregar (valor, QR e copia-e-cola PIX, estado da cobrança); extrato paginado |
| `/superadmin/bureaus/<id>` | `superadmin` | seção "Carteira": saldo, extrato, ajuste manual com motivo |

## Critérios de pronto

Cada critério aponta para o teste que o prova.

- `reserve`, `capture` e `release` movem `available` e `reserved` conforme o item 4 (Task 2).
- O saldo nunca fica negativo, nem com duas reservas concorrentes (Task 1, 2).
- Chamada repetida com a mesma `idempotency_key` não altera o saldo (Task 2).
- UPDATE e DELETE em `ledger_entries` falham, inclusive via role da aplicação (Task 1).
- A soma dos lançamentos de um Bureau é igual ao saldo da carteira (teste de conciliação) (Task 1, 2).
- O admin do Bureau A não lê nem recarrega a carteira do Bureau B (Task 1).
- Webhook com token inválido devolve 401 e não grava nada (Task 3).
- Webhook repetido não credita duas vezes (Task 3).
- Webhook credita o valor do registro local, mesmo que o corpo informe outro valor (Task 3).
- Cobrança abaixo do mínimo ou acima do máximo é rejeitada (Task 3).
- `adjustment` sem motivo é rejeitado; só o superadmin o executa (Task 2).
- `/settings/wallet` mostra saldo, QR da recarga e extrato; o operador não vê o botão Recarregar (Task 4).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da última onda.
- (post-deploy) O contrato real do Asaas (criação de cobrança PIX, QR, nome do evento, header do token) é validado com uma cobrança de valor mínimo na conta real.

## Alterações pós-review

- Estorno: novo tipo de lançamento `reversal`, status de cobrança `refunded` e coluna `pix_charges.refund_shortfall`. Se o saldo não cobre o estorno, o `shortfall` aparece como aviso na tela do superadmin, que recupera o valor com ajuste manual.
- Role separada `app_webhook` (senha em `app_webhook_password`, conexão em `DATABASE_WEBHOOK_URL`): só a rota do webhook a usa, com EXECUTE em `apply_asaas_payment`.
- Limite de 10 PIX pendentes é brando: contagem e insert rodam em transações diferentes, com a chamada ao Asaas no meio.
- PIX pago depois dos 30 minutos continua creditado (decisões 8 e 10).
- `reserve`, `capture` e `release` não gravam auditoria; o ledger é o registro (decisão 13).
- Evento do Asaas sem `id` no topo: o `event_id` é derivado como `<evento>:<id do pagamento>`.
- Extrato: `order by` qualificado (`ledger_entries.seq`). Antes ordenava pela coluna de saída em texto, e o cursor pulava ou repetia linhas a partir do seq 10.

## Riscos

- Não há sandbox Asaas hoje. Os testes usam o fake; o contrato real só é provado no item `(post-deploy)`. Antes de ativar, o responsável confere a documentação vigente do Asaas.
- O saldo materializado pode divergir do ledger. A função `wallet_apply` é o único caminho de escrita e o teste de conciliação cobre a divergência.
- O webhook é uma entrada pública. A validação do token, a idempotência e o crédito a partir do valor local limitam o abuso.
- Dinheiro entra na plataforma e sai por repasse manual (M3b). Obrigação fiscal e conciliação ficam com o superadmin.

## Plano de tarefas (resumo para o plano de execução)

| Task | Agente | Conteúdo | Depende de |
|---|---|---|---|
| 1 | `database-architect` | `012_wallet.sql`: tabelas, triggers, RLS, funções `wallet_apply` e `apply_asaas_payment`; testes de isolamento, imutabilidade e concorrência | — |
| 2 | `backend-specialist` | `src/lib/wallet/` (`reserve`, `capture`, `release`, `adjust`, extrato), permissões `wallet:*`, auditoria; testes | 1 |
| 3 | `backend-specialist` | `src/lib/asaas/` (adaptador + fake), action de recarga, rota `api/webhooks/asaas`; testes | 1, 2 |
| 4 | `frontend-specialist` | `/settings/wallet` e seção "Carteira" em `/superadmin/bureaus/<id>` | 2, 3 |

Ondas: 1 → 2 → 3 → 4. A Task 3 usa as funções da Task 2, por isso não corre em paralelo. Review uma vez, no fim, sobre o diff inteiro do M3a. Por envolver dinheiro e segurança, o review final usa `code-reviewer` e `security-reviewer`.
