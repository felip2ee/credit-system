# Links de pagamento: operação

Runbook do link `/pagar/<token>`, do Pix dele e da baixa pelo webhook. Regras do produto: [PRODUCT.md](../../PRODUCT.md). Desenho: [spec do app do Bureau](../superpowers/specs/2026-11-24-bureau-admin-app-design.md). Tabelas e funções: [architecture.md](../architecture.md#links-de-pagamento).

## 1. Fluxo: da criação ao pago

1. O operador abre uma consulta em `/admin/consulta` (`openCounterOrderAction`).
2. O operador gera o link. Sai um token de 32 bytes. O banco guarda só o hash. A validade é de 7 dias.
3. O operador copia o link ou envia por WhatsApp.
4. O cliente abre `/pagar/<token>`. A página valida o token e a validade. Ela cria um Pix de 30 min, ou reusa o Pix pendente que ainda não expirou. O Pix cobra o que falta pagar: o preço menos os pagamentos de balcão não anulados (veja o item 3).
5. O cliente paga o Pix.
6. O Asaas chama `POST /api/webhooks/asaas`. O evento é gravado em `asaas_webhook_events`.
7. Na mesma transação: o link vira `paid`, entra um pagamento de balcão (`counter_payments`, método Pix) e a consulta avança.

Um link pago não gera nova cobrança enquanto o pedido não volta a aguardar pagamento (veja "Estorno" no item 3). Um Pix expirado não bloqueia o link: basta reabrir `/pagar/<token>`.

## 2. O link ficou sem pagamento

Verifique nesta ordem:

1. **Validade do link.** Passados 7 dias, a página não aceita o token. O status pode continuar `active` no banco. Isso não é erro.
2. **Validade do Pix.** O Pix vale 30 min. Peça ao cliente que reabra a página para gerar um novo.
3. **Entrega do webhook.** No painel do Asaas, confira se o evento de pagamento recebido foi enviado e se o servidor respondeu 200. Depois, no banco (leitura), confira o resultado do evento:

   ```sql
   select result, created_at from asaas_webhook_events order by created_at desc limit 20;
   ```

4. **Resultado do evento.** Estes valores indicam o que aconteceu:

   | `result` | Significado | Ação |
   |---|---|---|
   | `link_paid` | Baixa feita. | Nenhuma. |
   | `link_duplicate` | Evento repetido. Nada foi baixado de novo. | Nenhuma. |
   | `link_ignored` | Evento que não muda o link. | Confira o evento no Asaas. |
   | `link_order_not_payable` | O cliente pagou, mas a consulta já foi paga no balcão ou cancelada. Nada foi lançado. | Verifique no Asaas e trate o valor fora do sistema (veja o item 5). |
   | `link_overpaid` | O Pix tinha o valor da cobrança e foi lançado como pagamento de balcão, mas a soma dos pagamentos passou o preço (entrou pagamento de balcão depois da cobrança). O pedido avançou. | Confira o excedente na tela de pagamentos de balcão. Devolva a diferença ao cliente pelo Asaas e anote. |
   | `amount_mismatch` | Valor pago diferente do valor da cobrança: menor **ou maior**. Nada foi lançado. | Verifique no Asaas o valor cobrado e o pago. Devolva ou trate o valor fora do sistema. |
   | `link_refund_ignored` | Estorno ou chargeback do Pix do link. Nada foi revertido no sistema. Um Pix ainda pendente que recebe estorno vira `refunded`: um pagamento tardio dele não baixa o pedido. | Confira o pedido e o pagamento de balcão. Trate o estorno como em "Estorno" (item 3). |

5. **Log do servidor.** Procure estas linhas:
   - `[asaas-webhook] pix de link sem pedido pagável` (`link_order_not_payable`). O cliente pagou, e o sistema não baixou nada.
   - `[asaas-webhook] pix de link maior que o saldo da consulta` (`link_overpaid`). O Pix foi lançado e a soma passou o preço. O log traz o id da cobrança no Asaas.
   - `[asaas-webhook] valor divergente` (`amount_mismatch`). Nada foi creditado.
   - `[asaas-webhook] estorno de pix de link sem tratamento` (`link_refund_ignored`). O log traz o evento e o id da cobrança no Asaas.
   - `[payment-link-pix] falhou ao cancelar Pix antigo no Asaas`. O cancelamento do Pix antigo falhou. A cobrança nova não foi afetada.
   - `[payment-link-pix] falhou em <etapa>`. A criação do Pix falhou naquela etapa. Veja o nome da etapa no log.
   - `[payment-link-pix] COBRANÇA sem ligação no banco`. O Asaas criou a cobrança, mas a linha não foi ligada no banco. O webhook acha a cobrança pela referência externa. Confira antes de pedir um novo Pix.

Não copie CPF/CNPJ dos logs para tickets. Os logs trazem só o id da cobrança no Asaas.

## 3. Limites conhecidos

- **Dinheiro.** O Pix do link cai na conta Asaas da plataforma. Nada repassa o valor ao Bureau.
- **Carteira.** O Pix do link nunca credita carteira do cliente ou do Bureau.
- **NFS-e.** O Pix do link não pede NFS-e. Se a nota for exigida, trate-a fora do sistema.
- **Pagamento parcial.** O pedido de balcão aceita pagamento parcial. O Pix do link cobra só o que falta (preço menos os pagamentos de balcão não anulados). Fora de R$ 10,00 a R$ 5.000,00, o sistema não gera o Pix: gerar o link já é recusado, com a orientação de registrar o restante no balcão. Se o balcão cobrir o preço todo, não há Pix nem link. O pagamento de balcão só é aceito com o pedido aguardando pagamento e até o valor que falta; o sistema trava o pedido nos dois caminhos (balcão e webhook), então Pix e dinheiro juntos nunca lançam o mesmo saldo duas vezes.
- **Pix e balcão ao mesmo tempo.** Entrou pagamento de balcão depois da cobrança e o cliente pagou o Pix de valor antigo: o Pix é sempre lançado (o dinheiro recebido não fica sem lançamento) e o pedido avança. Se a soma passou o preço, o resultado é `link_overpaid` e a diferença deve ser devolvida ao cliente. Se o balcão foi anulado depois da cobrança, o Pix é lançado, o pedido continua aguardando o restante e o link segue ativo: reabra `/pagar/<token>` para gerar o Pix do que falta.
- **Pix antigo.** Ao trocar o Pix (vencido ou de outro valor) e ao gerar um link novo para o pedido, o sistema cancela o Pix antigo no Asaas. É melhor esforço: se o cancelamento falhar, o Pix antigo pode continuar pagável no Asaas. Se for pago, o webhook baixa como hoje.
- **Estorno.** Estorno de Pix de link é manual:
  1. Estorne o Pix no painel do Asaas (ou confira lá o estado do dinheiro retido antes de qualquer outra ação).
  2. Anule o pagamento de balcão correspondente na tela de pagamentos de balcão.

  Ao anular o pagamento de balcão de um link pago, o pedido volta a `awaiting_payment` e o link continua `paid`. Isso não bloqueia mais: gerar o link decide pelo pedido, e um pedido aguardando pagamento com saldo a pagar aceita um link novo. Não gere o link novo nem reabra o Pix antes de estornar ou conferir o dinheiro retido no Asaas; senão o cliente pode ficar com dois pagamentos para o mesmo saldo.
- **Pix pendente do link não é cancelado no Asaas** quando o pedido é pago por inteiro no balcão ou cancelado. Se o cliente pagar esse Pix, ele cai em `link_order_not_payable`: a equipe estorna no Asaas.
- **Cancelamento de pagamento já recebido.** O cancelamento (`DELETE`) de um pagamento do Asaas que já foi recebido não foi verificado no sandbox. Trate o estorno pelo painel.
- **Cliente Asaas reaproveitado.** O cliente Asaas de um titular é reaproveitado e guarda o primeiro nome, documento e e-mail enviados. Mudanças posteriores no cadastro do titular não chegam ao Asaas.
- **Visitas.** A contagem da vitrine inclui bots. Não compare o número com analytics de navegador.

## 4. Após o deploy (post-deploy)

- Pague um link real com Pix e confira a baixa pelo webhook (`link_paid`) e o pedido avançado.
- Abra um link expirado e confira a mensagem de validade.
