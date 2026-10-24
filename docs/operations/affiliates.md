# Programa de afiliados

Runbook da carência, da fila de saques e do pagamento. Regras do produto: [PRODUCT.md](../../PRODUCT.md). Spec: [2026-10-24-programa-de-afiliados-design.md](../superpowers/specs/2026-10-24-programa-de-afiliados-design.md).

**Antes de liberar saques em produção:** o contador deve validar o tratamento fiscal do saque. Este item é **(post-deploy)**. Ele não bloqueia o merge. Enquanto a validação não existir, não avise os clientes sobre a função de saque.

**Flag do saque:** `AFFILIATE_WITHDRAWALS_ENABLED`. O saque nasce desligado: só o valor `true` liga. Desligado, o portal mostra "Saque disponível em breve." no lugar de "Sacar por PIX", e o pedido de saque é recusado com "O saque ainda não está disponível.". A conversão em créditos, a carência e a fila do superadmin continuam. Para liberar, depois da validação do contador, defina `AFFILIATE_WITHDRAWALS_ENABLED=true` no deploy e reinicie o app.

## 1. Como a comissão nasce

1. O cliente A copia o link em `/portal/afiliacao`.
2. O cliente B se cadastra pelo link. O vínculo nasce nesse momento e não muda.
3. B compra online. Quando o pedido é capturado, a comissão é uma % da margem do Bureau (preço menos custo).
4. A comissão só nasce se B tem o celular verificado.
5. A comissão entra em "Em carência". Depois do prazo, ela passa a "Comissão disponível".

O estorno da recarga PIX do indicado reverte primeiro a comissão ainda em carência. Só o que sobra é cobrado do Bureau. Comissão já liberada não é revertida.

## 2. % do Bureau

O Bureau define a % padrão e a % por afiliado em `/afiliados`. A % vale na captura e fica gravada na comissão. Mudar a % não altera comissões já criadas.

## 3. Carência

- Configuração: `/superadmin/settings/afiliados`, campo de dias de carência (`affiliate_commission_hold_days`, padrão 30).
- O tick `POST /api/internal/orders/tick` chama `release_due_commissions()`. A função libera as comissões com `release_at` vencido.
- O prazo gravado na comissão não muda quando o superadmin altera a configuração.

## 4. Fila de saques

1. A afiliada pede o saque em `/portal/afiliacao/saque`. Ela informa a chave PIX e declara que a chave está no nome dela.
2. A taxa de saque é a configuração `affiliate_withdrawal_fee` (valor fixo mais %). O valor líquido é o valor menos a taxa. A afiliada vê a taxa em `/portal/afiliacao` e em `/portal/afiliacao/saque`.
3. O valor sai do saldo disponível no momento do pedido.
4. A chave CPF/CNPJ precisa ser o documento da conta. O sistema recusa outra.
5. O superadmin vê os saques abertos em `/superadmin/saques`, do mais antigo ao mais novo. A chave PIX aparece mascarada. O detalhe mostra a chave completa e o documento da conta mascarado.

Com uma sessão de suporte ativa, a fila não abre. Encerre a sessão de suporte.

## 5. Pagar fora do sistema

1. Abra o saque em `/superadmin/saques/<id>`.
2. Pague o valor líquido por PIX no banco da empresa.
3. Anexe o comprovante (PDF, PNG ou JPEG, até 5 MB). O sistema verifica o tipo e passa o antivírus.
4. Clique em **Marcar como pago** e confirme. A ação não pode ser desfeita.

Não existe repasse automático.

## 6. Cancelar um saque

1. Abra o saque aberto.
2. Escreva o motivo (até 500 caracteres). A afiliada vê o motivo.
3. Confirme. O valor volta ao saldo disponível da afiliada.

Um saque pago não pode ser cancelado.

## 7. Anonimização (LGPD) de uma afiliada

A anonimização fica bloqueada se a afiliada tem comissão disponível ou saque aberto: ela precisa sacar antes. A comissão ainda em carência é perdida na anonimização (decisão do designer; validar com o jurídico).

## 8. Conversão em créditos

A afiliada converte parte do saldo disponível em créditos em `/portal/afiliacao`. Um crédito vale R$ 1. A conversão não tem taxa e não pode ser desfeita. O crédito convertido não pode ser sacado.

## 9. Teste e2e

`e2e/affiliate.spec.ts` cobre o fluxo completo: link, cadastro, compra, carência, tick, conversão, saque e pagamento. O teste roda com `AFFILIATE_WITHDRAWALS_ENABLED=true` (definido no `ci.yml`). Ele confirma o celular, define o saldo do indicado e captura o pedido direto no banco. Ele não depende da execução da pesquisa.
