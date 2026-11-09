# Pagamentos por pagador: operação

Este runbook cobre a chave de cifra, as taxas repassadas do cartão e do Pix, recusas, clientes Asaas e as checagens após o deploy. Produto: [PRODUCT.md](../../PRODUCT.md). Desenho: [spec de 2026-11-06](../superpowers/specs/2026-11-06-pagamento-por-pagador-design.md).

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

## 2. Taxas repassadas ao pagador (cartão e Pix)

Decisão do dono: repassar todas as taxas do Asaas ao cliente. O saldo sobe sempre pela **recarga** (`pix_charges.amount`). A taxa é paga a mais pelo pagador. A comissão de afiliado não usa a recarga: ela nasce na captura de um pedido, sobre a margem. A taxa nunca entra nela.

### Taxas reais da conta Asaas (tela "Taxas", novembro de 2026)

| Forma | Taxa da conta | Configuração |
|---|---|---|
| Cartão à vista | 2,99% + R$ 0,49 | `CARD_FEE_TABLE` faixa 1 |
| Cartão 2 a 6 parcelas | 2,99% + R$ 0,49 | `CARD_FEE_TABLE` faixa 6 |
| Cartão 7 a 12 parcelas | 2,99% + R$ 0,49 | `CARD_FEE_TABLE` faixa 12 |
| Cartão 13 a 21 parcelas | existe no Asaas | não oferecido (máximo 12) |
| Pix dinâmico | R$ 1,99 por cobrança recebida | `PIX_FEE_CENTS=199` |
| Boleto | R$ 1,99 | não usado |

Valores de produção, conferidos na tela de taxas do Asaas em 2026-11-09: `CARD_FEE_TABLE=1:2.99:49,6:2.99:49,12:2.99:49` (padrão da stack) e `PIX_FEE_CENTS=199`. O Asaas cobra 4,29% + R$ 0,49 de 13 a 21 parcelas; o app não oferece mais de 12. Os valores não ficam fixos no código: vêm do ambiente.

**Premissa a confirmar no teste real pós-deploy:** em outras contas, o Asaas cobra 1,99% extra sobre o total da cobrança parcelada. A tela "Taxas" desta conta não mostra essa taxa, e ela não está modelada. Faça uma recarga parcelada de teste e compare o líquido recebido com o esperado. Se a taxa extra existir, ajuste as faixas de 2 a 12 parcelas em `CARD_FEE_TABLE`.

### Como atualizar e quando mudam

- Quando o Asaas mudar a tabela da conta (ou o contrato mudar), edite `CARD_FEE_TABLE` e `PIX_FEE_CENTS` no `.env.production` e reimplante a stack. Formato em [setup.md](../setup.md). Não precisa de migration nem de deploy de código.
- A cobrança nova usa o valor novo. A cobrança já criada guarda a taxa que valia (`fee_amount`, `total_charged`) e é conferida contra ela: um QR Pix gerado antes da troca continua válido pelo total antigo.
- Confira a tela "Taxas" do Asaas a cada troca de plano e a cada aviso do Asaas.

### Cartão

- Configuração: `CARD_FEE_TABLE` e `CARD_MIN_INSTALLMENT_CENTS`.
- `CARD_FEE_TABLE` vazia: cartão desligado. A tela não mostra a opção.
- Total = (recarga + taxa fixa) / (1 − taxa%), arredondado para cima ao centavo. As parcelas são iguais. A última parcela leva o resto. O pagador paga a taxa.
- O servidor calcula o total. O total enviado pelo navegador é ignorado.
- Planos com parcela abaixo de `CARD_MIN_INSTALLMENT_CENTS` não aparecem.

### Pix

- Configuração: `PIX_FEE_CENTS`, inteiro em centavos de 0 a 1000. `199` = R$ 1,99.
- Em produção a variável é obrigatória. `0` explícito = sem taxa. Ausente ou vazia = erro de configuração: o Pix falha fechado ("Pagamento indisponível. Contate o suporte.") e o log grava só o nome do erro, sem valor. Fora de produção, ausente = 0.
- Três travas contra a variável vazia: `docker-stack.yml` recusa o deploy (`${PIX_FEE_CENTS:?...}`), o instalador grava `PIX_FEE_CENTS=199` no `.env.production`, e `npm run verify:release` falha se ela estiver vazia (e avisa se `CARD_FEE_TABLE` estiver vazia).
- Valor inválido (negativo, decimal, texto, acima de 1000): o Pix falha fechado com "Pagamento indisponível. Contate o suporte.". O cartão não é afetado.
- Total = recarga + taxa (soma em centavos inteiros). Exemplo: recarga R$ 100,00 + taxa R$ 1,99 = R$ 101,99 enviado ao Asaas. O saldo sobe R$ 100,00.
- Banco: `pix_charges.amount` = recarga, `fee_amount` = taxa, `total_charged` = recarga + taxa. Sem taxa, `fee_amount` = 0 e `total_charged` fica nulo (como antes). Quem lê o valor pago usa `coalesce(total_charged, amount)`.
- Webhook: o valor pago (`payment.value`) tem de ser igual ou maior que `coalesce(total_charged, amount)`. Menor vira `amount_mismatch` e não credita (por exemplo, o pagador pagou só a recarga). O crédito é sempre a recarga.
- Estorno e chargeback: o pagador recebe o total de volta do Asaas. A taxa do Pix devolvida é custo do Bureau/plataforma. Saldo e comissão revertem só a recarga (`amount`), nunca o total.
- **Ordem de deploy:** rode a migration 045 antes de subir o app novo (`npm run db:migrate`, depois o deploy da stack). Com o app novo e sem a 045, o Pix com taxa falha fechado: a linha com `total_charged` não passa na constraint antiga.
- **Alarme (Pix pago sem taxa):** depois do deploy, esta consulta deve voltar vazia. Troque a data pela do deploy. Linhas aqui indicam taxa não repassada (variável errada ou app antigo no ar). Cobranças anteriores à data são esperadas sem taxa.

```sql
select id, bureau_id, amount, created_at
from pix_charges
where billing_type = 'PIX' and status in ('paid', 'refunded') and fee_amount = 0
  and created_at >= '2026-11-10'::timestamptz;  -- data do deploy
```
- O limite de R$ 10,00 a R$ 5.000,00 vale para a recarga. O total pode passar de R$ 5.000,00 pela taxa.
- A tela recebe `summary` (recarga, taxa e total em centavos) da action de recarga e `pixCharge` do contexto do checkout (`getCheckoutContextAction`), para mostrar "Recarga R$ X + taxa Pix R$ 1,99 = R$ Y". A conta pura é `computePixCharge` em `src/lib/wallet/pix-fees.ts`.
- Migration 045 (`pix_fee_passthrough`): permite `total_charged` no Pix e confere o valor pago contra o total.

## 3. Recusa e limite de tentativas

- **Recusa do cartão** (HTTP 400 do Asaas): o pagador vê uma mensagem segura. A linha reservada vira `cancelled`. Nenhum crédito é feito.
- **Resultado desconhecido** (timeout ou 5xx): a linha fica pendente.
- **Crédito:** só pelo webhook. Nunca na resposta síncrona.
- **Limite:** por hora, no máximo 5 linhas de cartão por solicitante (`MAX_CARD_ATTEMPTS_PER_HOUR`), 10 por IP (`MAX_CARD_ATTEMPTS_PER_IP_PER_HOUR`) e 40 por Bureau (`MAX_CARD_ATTEMPTS_PER_BUREAU_PER_HOUR`). A contagem usa o mesmo lock da reserva e vale só para cartão.
- **Estorno:** o estorno de qualquer parcela reverte o crédito inteiro, uma vez.
- **Chargeback:** `PAYMENT_CHARGEBACK_REQUESTED` reverte o crédito como o estorno. `PAYMENT_CHARGEBACK_DISPUTE` e `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` não mudam saldo; ficam como `chargeback_ignored` e vão ao log. Acompanhe esses eventos à mão no painel do Asaas.
- **Valor pago menor que o esperado:** o evento fica como `amount_mismatch`, sem crédito, e vai ao log. Valor igual ou maior credita o valor da linha.

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
- Nunca reaproveite um cliente achado pelo CPF/CNPJ. Um cliente achado pelo documento pode ser de outra pessoa, e a nota fiscal dele (nome, endereço, e-mail) apareceria no recibo de quem pagou.
- Dono: o sistema busca o cliente pela referência do perfil do dono (`externalReference`) e só cria se não achar. Só atualiza o cliente que o sistema criou para aquele dono. Se o cliente foi apagado no Asaas, o sistema limpa o vínculo e cria outro, uma vez.
- Outra pessoa ou empresa: sempre cria um cliente novo com os dados digitados. A referência é o id da cobrança, então uma nova tentativa encontra o mesmo cliente.
- Clientes novos saem com `notificationDisabled: true`, para evitar e-mail do Asaas ao pagador. Confirmar após o deploy.
- **Cliente órfão:** se duas requisições criam cliente para o mesmo dono, uma vence. O cliente extra fica no Asaas sem uso e não afeta o saldo. O log grava só o id. O spec não define o procedimento de conciliação.
- **Cobranças antigas:** cobranças criadas com `ASAAS_CUSTOMER_ID` mantêm o cliente antigo. Uma nova tentativa de nota dessas cobranças sai para "Recargas Rainhas".

## 7. Checagens após o deploy

- O `.env.production` tem `PIX_FEE_CENTS=199` e `CARD_FEE_TABLE` com a tabela real. Uma recarga Pix de teste cobra recarga + R$ 1,99 e credita só a recarga.
- Uma recarga parcelada de teste mostra se o Asaas cobra a taxa extra sobre o parcelamento (premissa da seção 2).
- `GET /v3/customers?cpfCnpj=` devolve o cliente, e o filtro de clientes apagados funciona.
- A conta Asaas aceita cartão direto pela API.
- O formato do webhook de parcelamento e o primeiro `PAYMENT_CONFIRMED`.
- A nota do parcelamento e o valor aceito pela prefeitura.
- `notificationDisabled` evita e-mail ao pagador.
- A NFS-e de teste mostra nome e CPF/CNPJ do pagador.
- A chave PII está no gerenciador de senhas da operação.
