# Pagamentos por pagador: operação

Este runbook cobre a chave de cifra, as taxas do cartão, recusas, clientes Asaas e as checagens após o deploy. Produto: [PRODUCT.md](../../PRODUCT.md). Desenho: [spec de 2026-11-06](../superpowers/specs/2026-11-06-pagamento-por-pagador-design.md).

## 1. Chave PII

A chave cifra documento, CEP e número do dono da conta (`payer_profiles`). Sem chave válida, esses dados ficam ilegíveis e a recarga falha.

- **Gerar:** o instalador (`scripts/setup/setup_production.py`) gera o secret `pii_encryption_key`, no formato `k1:` seguido de 32 bytes em base64.
- **Guardar:** o instalador grava a chave no arquivo de credenciais "GUARDAR". Guarde a chave também no gerenciador de senhas da operação. O backup do banco leva o blob cifrado. Nunca leva a chave.
- **Atualizar sem chave:** se outros secrets existem e `pii_encryption_key` falta, o instalador gera a chave e avisa. Ele nunca recria uma chave que já existe.
- **Rotacionar:**
  1. Crie o secret `pii_encryption_key_v2` com `k2:<nova>,k1:<antiga>`. A primeira chave cifra. Todas decifram.
  2. Troque o `source` do secret na stack (`target: pii_encryption_key`). O Docker secret é imutável.
  3. Cada leitura no caminho da cobrança recifra a linha com a chave ativa.
  4. Mantenha a chave antiga até este comando mostrar só a chave nova:

     ```sql
     select pii_key_id, count(*) from payer_profiles group by 1;
     ```

  Linhas sem cobrança nova ficam com a chave antiga. Não há script de recifragem em lote neste escopo.
- **Perda da chave:** o blob fica ilegível. O dono digita os dados de novo. Nenhum saldo nem cobrança depende do blob.
- **Chave ausente ou inválida:** o checkout mostra "Pagamento indisponível. Contate o suporte.". O log grava só o nome do erro.

## 2. Taxas e parcela mínima do cartão

- Configuração: `CARD_FEE_TABLE` e `CARD_MIN_INSTALLMENT_CENTS`. Formato em [setup.md](../setup.md).
- `CARD_FEE_TABLE` vazia: cartão desligado. A tela não mostra a opção.
- Total = (recarga + taxa fixa) / (1 − taxa%), arredondado para cima ao centavo. As parcelas são iguais. A última parcela leva o resto. O saldo sobe pelo valor da recarga. O pagador paga a taxa.
- O servidor calcula o total. O total enviado pelo navegador é ignorado.
- Planos com parcela abaixo de `CARD_MIN_INSTALLMENT_CENTS` não aparecem.
- Após o deploy: ajuste as taxas e a parcela mínima com a tabela real da conta Asaas.

## 3. Recusa e limite de tentativas

- **Recusa do cartão** (HTTP 400 do Asaas): o pagador vê uma mensagem segura. A linha reservada vira `cancelled`. Nenhum crédito é feito.
- **Resultado desconhecido** (timeout ou 5xx): a linha fica pendente.
- **Crédito:** só pelo webhook. Nunca na resposta síncrona.
- **Limite:** no máximo 5 linhas de cartão por solicitante por hora (`MAX_CARD_ATTEMPTS_PER_HOUR = 5`). A contagem usa o mesmo lock da reserva.
- **Estorno:** o estorno de qualquer parcela reverte o crédito inteiro, uma vez.

## 4. Dados de cartão

- Nunca gravar nem logar: número, CVV, validade, corpo da requisição ou `creditCardHolderInfo`.
- O banco guarda só: ids do Asaas, bandeira, últimos 4 dígitos, parcelas, taxa e total.
- O IP do pagador vem dos cabeçalhos, pela regra de proxy confiável (`TRAEFIK_PROXY_CIDR`).

## 5. Dados do pagador

- **Dono da conta:** o sistema usa os dados de `payer_profiles`. Cliente sem essa linha: usa CPF/CNPJ, CEP e número do cadastro do Titular. A cópia cifrada acontece na primeira cobrança.
- **Campos pedidos:** só os que faltam para a forma escolhida. A matriz está na seção "Fluxo do checkout" do spec. Com a NFS-e ligada, o Pix pede CEP e número do dono.
- **Outra pessoa ou empresa:** nada vai para `payer_profiles`. A regra de retenção está em [lgpd.md](lgpd.md).
- **Nota fiscal:** ver [nfse.md](nfse.md).

## 6. Cliente Asaas

- Cada pagador tem um cliente Asaas. `ASAAS_CUSTOMER_ID` não existe mais.
- Dono: o sistema busca o cliente pelo CPF/CNPJ antes de criar. Só atualiza o cliente que o sistema criou para aquele dono.
- Outra pessoa ou empresa: reaproveita o cliente achado pelo CPF/CNPJ, sem atualizar os dados.
- Clientes novos saem com `notificationDisabled: true`, para evitar e-mail do Asaas ao pagador. Confirmar após o deploy.
- **Cliente órfão:** se duas requisições criam cliente para o mesmo dono, uma vence. O cliente extra fica no Asaas sem uso e não afeta o saldo. O log grava só o id. O spec não define o procedimento de conciliação.
- **Cobranças antigas:** cobranças criadas com `ASAAS_CUSTOMER_ID` mantêm o cliente antigo. Uma nova tentativa de nota dessas cobranças sai para "Recargas Rainhas".

## 7. Checagens após o deploy

- `GET /v3/customers?cpfCnpj=` devolve o cliente, e o filtro de clientes apagados funciona.
- A conta Asaas aceita cartão direto pela API.
- O formato do webhook de parcelamento e o primeiro `PAYMENT_CONFIRMED`.
- A nota do parcelamento e o valor aceito pela prefeitura.
- `notificationDisabled` evita e-mail ao pagador.
- A NFS-e de teste mostra nome e CPF/CNPJ do pagador.
- A chave PII está no gerenciador de senhas da operação.
