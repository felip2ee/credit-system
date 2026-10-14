# M3b — Financeiro restante: Desenho

**Data:** 2026-10-14
**Status:** rascunho (aguarda aprovação das decisões D1–D4 e revisão do restante)
**Milestone:** M3b, segunda metade do M3 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)
**Issues:** #27 (parcial), #30, #31, #32, #33. #28 fica parcial (ver D1).
**Depende de:** [M3a](2026-10-14-m3a-carteira-bureau-design.md) (carteira do Bureau, livro-razão, Asaas PIX, webhook) e [M2](2026-10-14-m2-catalogo-precos-design.md) (`quoteOrder`)

## Objetivo

Fechar o motor financeiro do M3:
- O cliente final tem carteira própria e recarrega por PIX (#30).
- Cada pedido reserva, captura ou libera saldo de forma idempotente, no modo online e no modo balcão (#27).
- O operador registra o pagamento recebido no balcão (#31).
- O superadmin gera e quita o repasse ao Bureau (#32).
- Cada pagamento confirmado gera uma NFS-e pelo Asaas (#33).

O M3b não cria o pedido de pesquisa. O M6 chama as funções de liquidação que o M3b entrega.

## Decisões que precisam da sua aprovação

| # | Decisão proposta | Alternativa | Custo se errada |
|---|---|---|---|
| D1 | **Cartão fica fora do M3b.** O MVP aceita só PIX. A issue #28 perde o critério "cartão" e ganha uma issue nova para cartão e chargeback. | Incluir cartão agora, com regra de chargeback e saldo negativo. | Clientes sem PIX não compram. Reabrir a spec para cartão. |
| D2 | **Tabelas separadas para a carteira do cliente** (`client_wallets`, `client_ledger_entries`), com a mesma função-núcleo do M3a. | Generalizar `wallets` e `ledger_entries` com `owner_type`. | Duplicação de SQL. A alternativa muda a chave primária da 012. |
| D3 | **NFS-e por pagamento confirmado**, para todo PIX que a plataforma recebe (recarga do Bureau e do cliente). | Emitir só no consumo (quando o custo vira receita da plataforma). | Tratamento fiscal errado. **O contador precisa validar antes do deploy.** |
| D4 | **Repasse por data de corte.** O superadmin escolhe Bureau e data; o repasse reúne todos os acréscimos ainda não repassados até a data. | Repasse por período fechado, mensal e automático. | Operação manual a cada ciclo. |

## Ponto de partida (M3a)

- `wallets` e `ledger_entries` do Bureau, com `wallet_apply` (reserve, capture, release, adjustment) e `apply_asaas_payment`.
- `pix_charges` só para recarga do Bureau. O webhook credita o Bureau.
- Role `app_webhook` com `EXECUTE` exclusivo em `apply_asaas_payment`.
- `reserve`, `capture` e `release` do Bureau aceitam qualquer identidade do Bureau e não sabem de pedido: só recebem `reference`.
- O portal do cliente (`(portal)`, `portal:read|write`) existe desde o M1. O auto-cadastro chega no M5.

## Modelo de dinheiro

Dois modos de venda, conforme o doc de produto:

- **Balcão:** o cliente paga o Bureau fora do sistema. O custo `C` sai do saldo pré-pago do Bureau (M3a). Não há repasse.
- **Online:** o cliente paga a plataforma por recarga. Na compra de um produto de preço `P` e custo `C`:
  - o cliente perde `P` da carteira dele;
  - a plataforma retém `C`;
  - `P − C` vira **valor a repassar** ao Bureau.

Invariante de caixa: `Σ client_wallets (available + reserved) + Σ wallets do Bureau (available + reserved) + Σ valores a repassar ainda não pagos` é igual ao dinheiro que a plataforma recebeu pelo Asaas, menos custos já retidos e repasses pagos. Um teste de conciliação cobre a parte que o banco enxerga.

## Decisões

1. **Carteira do cliente.** `client_wallets(client_profile_id pk, bureau_id, available, reserved)` com CHECK `>= 0`. `client_ledger_entries` tem o mesmo desenho do `ledger_entries` do M3a (imutável, `idempotency_key`, `seq`, `*_after`). Tipos: `topup`, `reserve`, `capture`, `release`, `reversal`. A função `client_wallet_apply` espelha `wallet_apply`. A carteira nasce com a conta do cliente (trigger em `profiles` com papel `client`) e há backfill sob a role `auth_profile_lookup`, como na migration 013.
2. **Recarga online do cliente (#30).** `pix_charges` ganha `client_profile_id` nulo. Se preenchido, o webhook credita a carteira do cliente em vez da do Bureau. CHECK: a cobrança é do Bureau ou do cliente, nunca dos dois. Faixa e expiração iguais às do M3a (R$ 10,00 a R$ 5.000,00; 30 minutos). Valores sugeridos na tela: R$ 20, 50, 100 e 200, mais valor livre.
3. **Liquidação por pedido (#27).** Tabela `order_settlements(id, order_ref unique, bureau_id, mode, client_profile_id, price, cost, price_version_id, status, created_at, closed_at)`. `order_ref` é o id do Dossiê. `status` segue `reserved → captured` ou `reserved → released`; nunca volta. `mode` é `online` ou `counter`.
   - `reserve_order(order_ref, mode, quote)`: grava a liquidação e reserva. Online reserva `P` na carteira do cliente. Balcão reserva `C` na carteira do Bureau.
   - `capture_order(order_ref)`: online captura `P` do cliente e grava o acréscimo `P − C` ao Bureau. Balcão captura `C` do Bureau.
   - `release_order(order_ref)`: libera a reserva. Não grava acréscimo.
   - As três são idempotentes por `order_ref` e usam chaves derivadas dele. Repetir a chamada devolve o estado atual sem alterar saldo. Capturar uma liquidação liberada (ou o inverso) devolve `{ ok: false, reason: "invalid_state" }`.
   - O valor vem de `quoteOrder` (M2) e é gravado na liquidação. O preço vigente não muda depois. A função recusa `P < C`.
4. **Valor a repassar.** `bureau_payable_entries(id, bureau_id, kind, amount, order_ref, payout_id, created_at)`, só INSERT. `kind`: `accrual` (+), `reversal` (−), `payout` (−, referencia o repasse). O saldo a repassar é a soma. Estorno de venda online grava `reversal` com o mesmo `order_ref`.
5. **Pagamento de balcão (#31).** `counter_payments(id, bureau_id, dossier_id, method, amount, received_at, registered_by, note, voided_at, voided_by, void_reason)`.
   - `method` em `cash`, `pix`, `card_machine`, `transfer`, `other`.
   - O registro não altera nenhuma carteira. Ele prova que o Bureau recebeu o dinheiro e libera o pedido de balcão no M6.
   - Um Dossiê aceita vários pagamentos (parcial). A tela mostra a soma contra o preço da liquidação.
   - Correção: anulação com motivo (`voided_*`), nunca DELETE nem UPDATE do valor. Trigger bloqueia as duas coisas.
   - Cada registro e cada anulação gravam auditoria na mesma transação.
6. **Repasse (#32).** `payouts(id, bureau_id, cutoff_at, amount, status, created_by, paid_at, paid_by, receipt_document_id)` e `payout_items(payout_id, entry_id unique)`.
   - `create_payout(bureau_id, cutoff_at)` (superadmin): junta todos os lançamentos `accrual` e `reversal` do Bureau até o corte que ainda não estão em nenhum `payout_items`. Recusa repasse de valor `<= 0` e repasse vazio.
   - Estado: `open → paid`. Marcar como pago exige comprovante (arquivo no módulo `src/lib/documents`, com a varredura do ClamAV) e grava o lançamento `payout` (−).
   - Cancelar um repasse `open` libera os itens. Repasse `paid` não se cancela.
   - Visão do Bureau: `bureau_admin` lê o valor a receber, os repasses e o extrato de lançamentos. O Bureau não grava nada.
7. **NFS-e (#33).** O Asaas emite a nota pelo pagamento. `pix_charges` ganha `nfse_status` (`not_requested`, `pending`, `issued`, `failed`), `nfse_number` e `nfse_url`.
   - Ao confirmar o pagamento, o webhook agenda a nota. Falha da nota **nunca** impede o crédito: o status vira `failed` e aparece numa lista do superadmin para nova tentativa manual.
   - Eventos de nota do Asaas atualizam o status. O handler segue as regras do webhook do M3a (token, idempotência, role `app_webhook`).
   - A configuração municipal (código do serviço, alíquota, inscrição) fica em `docs/operations/nfse.md` e em variáveis de ambiente. Sem a configuração, a plataforma não agenda nota e registra `not_requested`.
8. **Recibo e histórico (#30).** O cliente vê o extrato da carteira e, por recarga paga, uma página de recibo: valor, data, identificador e link da NFS-e quando existir. PDF próprio fica fora (YAGNI).
9. **Permissões novas.**
   - `client`: `credits:read`, `credits:topup`.
   - `operator`: `counter:read`, `counter:write`.
   - `bureau_admin`: `counter:read`, `counter:write`, `payout:read`.
   - `superadmin`: `payout:manage`, `nfse:manage`.
   - `reserve_order`, `capture_order` e `release_order` não são Server Actions no M3b. O M6 as chama a partir do fluxo de pedido.
10. **Acesso ao banco.** Todas as tabelas novas têm `bureau_id not null`, FK composta e a política de tenant do M1. O cliente lê só a própria carteira e o próprio extrato. O superadmin lê `payouts` e `bureau_payable_entries` de qualquer Bureau sem sessão de suporte (exceção estreita, como a do custo no M2). Só as funções do banco escrevem em carteiras, lançamentos e liquidações. O webhook continua na role `app_webhook`.
11. **Auditoria.** Cada mutação grava auditoria na mesma transação: recarga do cliente, liquidação, repasse (criar, pagar, cancelar), pagamento de balcão (registrar, anular), nota (nova tentativa). Nunca grava CPF/CNPJ, token nem comprovante.
12. **Dinheiro.** Igual ao M3a: `numeric(15,2)`, string decimal no TypeScript e centavos inteiros no cálculo.

## Telas

| Rota | Quem | Conteúdo |
|---|---|---|
| `/portal/credits` | `client` | saldo, recarga (valores sugeridos e livre), QR, extrato |
| `/portal/credits/receipts/<id>` | `client` | recibo da recarga e link da NFS-e |
| `/settings/counter-payments` | `operator`, `bureau_admin` | lista por Dossiê, registrar, anular |
| `/settings/payouts` | `bureau_admin` | valor a receber, repasses, extrato de lançamentos |
| `/superadmin/payouts` | `superadmin` | repasses abertos e pagos, criar por Bureau e corte, marcar pago com comprovante |
| `/superadmin/nfse` | `superadmin` | notas com falha e nova tentativa |

## Fora do escopo

- Cartão de crédito e chargeback (D1).
- Pedido de pesquisa, reserva ligada à tela e entrega (M6).
- Auto-cadastro do cliente (M5).
- Reembolso de saldo ao cliente.
- Repasse automático, repasse por transferência feita pelo sistema e conciliação bancária.
- PDF próprio de recibo.
- Preço por faixa, cupom e desconto.

## Critérios de pronto

Cada critério aponta para o teste que o prova.

- Reserva, captura e liberação por `order_ref` são idempotentes; repetir não altera saldo (Task 2).
- Capturar uma liquidação liberada e liberar uma capturada devolvem `invalid_state` (Task 2).
- Online: a captura debita `P` do cliente e grava o acréscimo `P − C`; balcão debita `C` do Bureau e não grava acréscimo (Task 2).
- `P < C` é recusado (Task 2).
- A carteira do cliente nunca fica negativa, nem com duas reservas concorrentes (Task 1, 2).
- A recarga do cliente credita a carteira dele e não a do Bureau; o webhook trata valor, duplicidade e pagamento tardio como no M3a (Task 3).
- O cliente A não lê a carteira nem o extrato do cliente B nem do Bureau (Task 1).
- `counter_payments` não aceita UPDATE de valor nem DELETE; a anulação exige motivo e é auditada (Task 1, 4).
- O repasse reúne só lançamentos ainda não repassados; um lançamento não entra em dois repasses (Task 2).
- Marcar pago sem comprovante é rejeitado (Task 2).
- O Bureau A não lê repasse nem lançamento do Bureau B; o `bureau_admin` não grava repasse (Task 1, 2).
- Falha da NFS-e não impede o crédito; a nota com falha aparece na lista (Task 3).
- A soma dos lançamentos de cada carteira e a soma a repassar batem com os saldos (teste de conciliação) (Task 1, 2).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da última onda.
- (post-deploy) Validar com o contador o tratamento fiscal da NFS-e (D3) e a configuração municipal.
- (post-deploy) Validar o contrato real do Asaas para NFS-e (agendar, eventos, campos) com um pagamento de valor mínimo.
- (post-deploy) Conferir as telas novas no navegador.

## Riscos

- **Fiscal (D3):** emitir nota na recarga pode estar errado se a receita da plataforma nasce só no consumo. Só o contador resolve. A emissão fica atrás de configuração e pode ser desligada sem migration.
- **Caixa:** a plataforma segura dinheiro de clientes e Bureaus. A invariante de caixa e a conciliação limitam o erro, mas a conciliação com o extrato do Asaas é manual até o M7.
- **Estorno online:** o `reversal` do valor a repassar pode ficar negativo depois de um repasse pago. O saldo negativo entra no próximo repasse; o repasse nunca sai negativo.
- **Dependência do M6:** as funções de liquidação só provam o fluxo por testes de integração. A ligação real vem no M6.
- **Duplicação (D2):** `client_wallet_apply` espelha `wallet_apply`. Um teste compartilhado roda os mesmos casos nas duas funções para evitar divergência.

## Plano de tarefas (resumo para o plano de execução)

| Task | Agente | Conteúdo | Depende de |
|---|---|---|---|
| 1 | `database-architect` | migration `015_*`: carteira e lançamentos do cliente, `order_settlements`, `bureau_payable_entries`, `payouts`, `payout_items`, `counter_payments`, colunas de NFS-e, RLS, funções, backfill; testes de isolamento, imutabilidade e concorrência | — |
| 2 | `backend-specialist` | `src/lib/wallet/` (carteira do cliente), `src/lib/settlement/` (`reserve_order`, `capture_order`, `release_order`), `src/lib/payouts/`, `src/lib/counter-payments/`, permissões, Server Actions, comprovante via `src/lib/documents`; testes | 1 |
| 3 | `backend-specialist` | recarga do cliente (`pix_charges.client_profile_id`, action, webhook), NFS-e no adaptador Asaas e no webhook, `docs/operations/nfse.md`; testes | 1, 2 |
| 4 | `frontend-specialist` | `/portal/credits`, recibo, `/settings/counter-payments`, `/settings/payouts`, `/superadmin/payouts`, `/superadmin/nfse` | 2, 3 |

Ondas: 1 → 2 → 3 → 4. O M3b é grande. Se o plano passar de 8 tarefas, divida em dois PRs: **M3b-1** (cliente, liquidação, balcão e recarga online) e **M3b-2** (repasse e NFS-e). Review uma vez por PR sobre o diff inteiro, com `code-reviewer` e `security-reviewer`.

## Ajustes nas issues

- #28: remover o critério "cartão"; criar issue nova "Cartão e chargeback" no backlog.
- #27: manter aberta até o M6 ligar as funções ao pedido.
- #30, #31, #32, #33: fechadas pelo PR do M3b que entregar cada uma.

## Alterações pós-review

Mudanças feitas depois do review do painel. Elas valem mais que o texto acima onde houver conflito.

- **Pedido de balcão com custo zero.** A migration 018 permite criar a liquidação no modo balcão com custo zero.
- **Custo e cotação.** O custo e a cotação ficam ocultos para o cliente. Ele vê só o preço.
- **Estorno de recarga.** O estorno também retira do saldo reservado, não só do disponível.
- **NFS-e: reparo no reenvio.** O reenvio do webhook de um crédito já aplicado repara a nota que ficou em `not_requested`. A função SQL `set_nfse_status` evita uma segunda emissão: só quem muda `not_requested` para `pending` agenda a nota.
- **Tipo `reversal`.** O tipo de lançamento `reversal` em `bureau_payable_entries` fica reservado para o M6.

### Limites conhecidos

- **Limite de cobranças pendentes.** O limite é brando. Duas criações ao mesmo tempo podem passar dele.
- **Limite de 6 MB.** O limite global de corpo de Server Action é 6 MB. O envio do comprovante deve migrar para um Route Handler.
- **Nota presa em `pending`.** Se o processo cair entre o pedido da nota e o registro, a cobrança fica em `pending` sem varredura que a retome.
