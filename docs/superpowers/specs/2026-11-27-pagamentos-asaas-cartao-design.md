# Pagamentos só pelo Asaas, com cartão em toda compra — Desenho

Data: 2026-11-27. Estado: aguarda aprovação do dono do produto.

## Intenção

Toda compra é paga pelo Asaas, em Pix ou cartão. O cliente paga a taxa. Toda venda paga a comissão de parceiros e Bureau, e a de afiliado quando há indicação.

## Decisões do dono

1. O Pix de pedido paga comissão, com split direto na conta Asaas.
2. Todo tipo de compra oferece cartão de crédito.
3. O cliente sempre paga a taxa.
4. Não existe pagamento fora do Asaas. O registro manual de balcão sai inteiro.
5. Montagem em três entregas, nesta ordem (caminho A).
6. A venda de balcão deixa de debitar o saldo do Bureau. O Bureau recebe a comissão pelo split, como na venda online.
7. Toda comissão é % do preço, sem a taxa, em todos os modos e tipos de compra, inclusive recarga.
8. No cartão do link, o pagador informa nome, CPF e e-mail do dono do cartão.
9. A venda por link não paga afiliado.
10. Pedido de balcão fora de R$ 10 a R$ 5.000 é recusado na abertura. Os que já existem são cancelados pela equipe.

## Fora do escopo

- Mudar percentuais de comissão. As regras mudam só como dizem as decisões 6, 7 e 9.
- Outro gateway ou outro meio de pagamento (boleto, débito).
- Apagar dados antigos de pagamento de balcão.
- Redesenho de telas além do necessário para o cartão e para a remoção.

## Abordagens

| Caminho | Como | Troca | Escolha |
|---|---|---|---|
| A | Fluxo do cliente, depois afiliados com a migração de junção, depois cartão | Três revisões menores. Não renumera migrações. | **Escolhido pelo dono** |
| B | Uma branch com tudo | Revisão enorme. Um erro trava tudo. | Rejeitado |
| C | Afiliados antes do fluxo | Obriga a renumerar as migrações do fluxo. | Rejeitado |

Cada entrega termina com revisão (`/code-review`, `code-reviewer`, `security-reviewer`) e PR. Push, merge e deploy precisam de autorização.

## Entrega 1 — Fluxo do cliente na `main`

Origem: `origin/feat/fluxo-4-autorizacao-editar-email` (32 commits à frente da `main`, migrações 063-069). Contém o trabalho das partes 2 e 3 que ainda não chegou à `main`.

- Atualizar sobre a `main` atual. Há conflitos com o redesenho do portal (PRs #116-#121). O visual da `main` vence. O comportamento do fluxo se mantém.
- Nenhuma regra de negócio nova.
- Pronto quando: `npm run check` passa em banco novo e o e2e passa.

## Entrega 2 — Afiliados sobre o fluxo

Origem: branch local `feat/afiliado-bureaus` (migrações 070-085, mais a 086 da correção S3-1).

- Atualizar sobre a `main` com a entrega 1.
- Migração nova (próximo número livre) que redefine `apply_asaas_payment` juntando os dois corpos:
  - o ramo de Pix de pedido (065) e o estorno que cancela pedido (066, 067);
  - o cash-in, o split e a reversão de comissão das migrações de afiliados.
- Comissão no pedido: `record_cash_in_commission` roda em todo resultado em que o dinheiro entrou (`order_paid`, `order_reserve_failed`, `order_not_payable`). Motivo: nos três o valor vira venda ou saldo, e o saldo não paga comissão de novo na captura (a 077 removeu).
- Estorno e chargeback de pedido revertem a comissão uma vez.
- A base da comissão é o `amount`, nunca a taxa. O split envia valores fixos calculados sobre o `amount` (total do parcelamento no cartão), no lugar de `percentualValue` sobre o valor líquido. Vale também para as recargas. A soma não pode passar do valor líquido da cobrança.
- Com cupom, a regra atual se mantém (contas sobre o preço bruto, desconto só da parte do Bureau).
- Atualizar `PRODUCT.md` e `docs/operations/affiliates.md`.
- Testes: banco novo e banco já migrado terminam com a mesma função; os três resultados acima; estorno depois de cada um.

## Entrega 3 — Cartão, taxa e fim do balcão manual

Branch nova sobre a `main` com as entregas 1 e 2. Feita depois dos PRs abertos #122-#134, que mudam as mesmas telas.

### Regras de cartão (as mesmas da recarga)

- Taxa pela `CARD_FEE_TABLE`. Até 12 parcelas, parcela mínima `CARD_MIN_INSTALLMENT_CENTS`, valor de R$ 10 a R$ 5.000.
- Sem `CARD_FEE_TABLE`, as telas oferecem só Pix.
- Dados do cartão passam só pela memória do servidor. Guardar bandeira, últimos 4 dígitos e ids. `remoteIp` obrigatório.
- HTTP 400 é recusa. Resultado desconhecido mantém a cobrança pendente. Nunca cobrar duas vezes.
- O primeiro `CONFIRMED`/`RECEIVED` confirma todas as parcelas.
- Estorno de qualquer parcela e `PAYMENT_CHARGEBACK_REQUESTED` revertem tudo, uma vez. Disputa e reversão de chargeback ficam manuais, com log.

### Pagamento do pedido (`/portal/pesquisas/[id]/pagar`)

- O cliente escolhe Pix ou cartão.
- Banco: a restrição que obriga `billing_type = 'PIX'` na cobrança de pedido (063) passa a aceitar `CREDIT_CARD`. O webhook confere o valor da parcela com a regra de cartão da recarga.
- Continua uma cobrança viva por pedido. Ao trocar de método, a nova cobrança só nasce depois do cancelamento confirmado no Asaas. Parcelamento é cancelado pelo id do parcelamento.
- Cartão sem resultado conhecido bloqueia a troca de método. Há um prazo máximo para a pendência, que vale também para o prazo do pedido.
- Pagamento tardio de cobrança cancelada vira saldo e paga comissão. Hoje o webhook responde `ignored` e o dinheiro entra sem crédito: corrigir sem colidir com o índice de uma cobrança viva por pedido. Cobrança estornada não é creditada.
- Cartão em análise não deixa o pedido ser cancelado por prazo de Pix.
- Com cupom, a repartição segue a regra atual: contas sobre o preço bruto, desconto só da parte do Bureau.
- Cartão recusado: o pedido continua aguardando e o cliente tenta de novo, dentro dos limites de tentativas.
- Pedido, reserva, saldo e estorno seguem as regras do Pix de pedido (063-067).

### Venda de balcão sem saldo do Bureau

- A abertura do pedido não reserva nem debita o saldo do Bureau (custo 0, como na venda online desde a 077).
- Pedido já aberto com reserva: a reserva é devolvida quando o link é pago, uma vez.
- Pedido novo fora de R$ 10 a R$ 5.000 (valor a pagar, já com cupom) é recusado na abertura, com mensagem clara.
- Pedido existente que o link não consegue cobrar é cancelado pela equipe, com devolução da reserva.

### Link de pagamento do balcão (`/pagar/<token>`)

- A página oferece Pix e cartão. O cartão pede nome, CPF, e-mail, CEP, número e telefone do dono do cartão. Esses dados não são guardados além do permitido nas regras de cartão. O CPF nunca vai para log, auditoria ou erro.
- O split do link paga parceiros, Bureau e Bureau indicador. Não paga afiliado.
- Taxa repassada nos dois métodos: Pix com `PIX_FEE_CENTS`, cartão com a tabela. `amount` é o preço, `fee_amount` a taxa, `total_charged` o valor cobrado. A página mostra o total antes de pagar.
- Rota pública: exige token válido e aplica limite por link e por IP, além dos limites atuais.
- Estorno e chargeback deixam de ser ignorados:
  - pedido que ainda não executa: anula o pagamento do link e o pedido volta a `awaiting_payment`, com o prazo de 7 dias contado de novo a partir do estorno;
  - pedido em execução ou concluído: o resultado não é retirado; o sistema registra a perda para tratamento manual, com auditoria e log;
  - nos dois casos a comissão e o repasse são revertidos uma vez.

### Fim do registro manual

- Remover a tela e as ações de registrar e anular pagamento de balcão, e a permissão que só elas usam.
- A tabela `counter_payments` continua: o webhook grava nela a baixa do link. O histórico aparece só para leitura.
- Migração: o banco recusa registro novo sem `pix_charge_id`.
- Pedido que espera pagamento passa a ser pago por link ou no portal. Pagamento manual antigo continua abatendo o valor.
- Atualizar `PRODUCT.md`, `docs/architecture.md`, `docs/operations/payment-links.md` e `docs/operations/payments.md`.

## Restrições

- Migração aplicada não muda. SQL parametrizado, `withUserTransaction`, auditoria na mesma transação.
- Nenhuma chamada ao Asaas dentro de transação. Dinheiro em centavos no TypeScript.
- Texto de interface em pt-BR.

## Riscos

- Cartão liquida depois da confirmação. No modo Pix, a comissão pode liberar antes de o dinheiro chegar (`affiliate_cash_in_hold_days` = 0 hoje). Recomendação: ajustar o prazo na operação.
- Split e formato de erro do Asaas não foram confirmados no sandbox (post-deploy).
- O Bureau perde a opção de receber em dinheiro.
- Bureau sem `walletId` passa a receber a venda de balcão só por repasse manual.

## A cargo do construtor

Nomes de funções, divisão dos componentes, números das migrações novas, textos de erro e casos de teste extras.
