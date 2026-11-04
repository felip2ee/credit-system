# Pagamento com cartão de crédito via Asaas — design

## Intenção

Quem hoje paga com Pix passa a poder pagar com cartão de crédito, à vista ou parcelado, em todas as telas de recarga de carteira. O crédito entra na carteira pelo mesmo caminho do Pix.

## Escopo

Dois fluxos de recarga existem hoje. Os dois ganham cartão:

- Recarga da carteira do bureau: `src/actions/wallet-topup.ts` (`requestTopupAction`), tela `src/components/wallet/TopupDialog.tsx`.
- Recarga do cliente no portal: `src/actions/credits-topup.ts` (`requestClientTopupAction`), tela `src/components/credits/ClientTopupDialog.tsx`.

O levantamento não achou cobrança Asaas em assinatura, consulta ou saque. Se achar outra tela com Pix durante a construção, ela também ganha cartão.

## Decisões do usuário

- O formulário de cartão fica dentro do app (sem página hospedada do Asaas).
- Parcelamento incluso.
- O cliente paga a taxa do cartão, inclusive à vista. Pix continua sem taxa.
- Taxas provisórias (contrato padrão do Asaas): à vista 2,99% + R$ 0,49; 2 a 6x 3,49%; 7 a 12x 3,99% (valor provisório, não confirmado). A faixa 2 a 6x também precisa de conferência.

## Decisões do design (chamadas minhas, o usuário pode mudar)

- Máximo de 12x, mesmo que Visa e Mastercard aceitem até 21x.
- Tabela de taxas em configuração, nunca fixa no código.
- Total cobrado = (recarga + taxa fixa) / (1 − taxa percentual). O Asaas repassa líquido o valor da recarga. O cliente vê o total e o valor da parcela antes de confirmar.
- O saldo sobe pelo valor da recarga, não pelo total cobrado.
- O crédito acontece só pelo webhook, nunca na resposta síncrona da API. Assim o caminho de crédito é um só.
- Sem cartão salvo. O cliente digita o cartão a cada compra.
- Estorno reaproveita o ramo `PAYMENT_REFUNDED` do webhook.
- A empresa assume o risco do parcelado: crédito integral na aprovação (decisão do usuário). Estorno ou chargeback de qualquer parcela reverte o crédito inteiro do parcelamento, pelo ramo de estorno existente.
- Dados do pagador (nome, CPF/CNPJ, e-mail, CEP, telefone): o cliente do portal digita a cada compra com cartão; no bureau usa os dados do dono (decisão do usuário). Não gravar CPF/CNPJ completo.

## Segurança (obrigatório)

O Asaas não tokeniza no navegador. O número do cartão passa pelo nosso servidor.

- Nunca gravar nem logar número, CVV, validade ou corpo da requisição. Isso inclui logs, auditoria, mensagens de erro e ferramentas de monitoramento.
- No banco só ficam: id do Asaas, bandeira, 4 últimos dígitos, número de parcelas, taxa e total cobrado.
- Enviar o IP do pagador ao Asaas (`remoteIp`).
- Validar a entrada com zod. SQL parametrizado. Escrever evento de auditoria na mesma transação da mutação, sem dados de cartão.
- Confirmar que a conta Asaas permite envio direto de dados de cartão.

## Chamadas adicionais do design (resposta ao revisor; o usuário pode mudar)

- Taxa fixa fica na tabela de configuração por faixa. Valor provisório: R$ 0,49 em todas as faixas (só a faixa à vista está confirmada). Conferir no painel Asaas.
- Arredondamento: o total cobrado sobe para o centavo seguinte. Parcelas iguais; o resto de centavos vai para a última parcela (como o Asaas faz).
- Tarifa de antecipação não entra na conta do cliente. Só a taxa de transação.
- Evento que credita: o primeiro `PAYMENT_CONFIRMED` do parcelamento. `PAYMENT_RECEIVED` posterior não credita de novo.
- Cobrança de cartão fica em tabela nova (`card_charges`), sem mexer em `pix_charges`. O construtor confirma se o livro-caixa aceita isso.
- Corrida webhook x resposta: reservar a linha antes de chamar o Asaas, como `reserveClientPixCharge` já faz.
- Tela após confirmar: mostra "processando", consulta o status a cada poucos segundos por até 60 s. Depois mostra "pagamento em análise; o saldo atualiza sozinho". Job de reconciliação fica fora do escopo.
- Clique duplo: chave de idempotência gerada por envio e botão travado. Limite de tentativas de cartão por usuário, reaproveitando o mecanismo de rate limit do projeto, se existir.
- Parcela mínima vem da configuração. O seletor esconde planos abaixo dela.

## Pontos técnicos a verificar na construção

1. Parcelado cria uma cobrança por parcela, com um id de parcelamento comum. O webhook chega por parcela, com `payment.id` diferente. `apply_asaas_payment` (migration 027) busca a cobrança por `asaas_payment_id` e trataria as outras parcelas como `unknown_charge`. Regra exigida: creditar uma vez só, no primeiro evento de confirmação do parcelamento, e ignorar os outros pelo id do parcelamento. Verificar o comportamento real no sandbox.
2. Parcela mínima do Asaas e campos obrigatórios (`creditCardHolderInfo`, `remoteIp`): confirmar em docs.asaas.com.
3. Recusa do cartão: a API devolve HTTP 400 e não cria cobrança. Mostrar erro claro em pt-BR, sem repetir dados do cartão.
4. Dados do pagador: o cliente do portal precisa informar nome, CPF/CNPJ, e-mail, CEP e telefone para `creditCardHolderInfo`. CPF/CNPJ completo não é gravado.

## Mudanças esperadas

- Cliente Asaas (`src/lib/asaas/`): função de cobrança por cartão, tipos, driver fake com cartão, testes.
- Banco: migration `040_*.sql` (038 e 039 já existem) com tipo de cobrança, parcelas, taxa, total e id do parcelamento em `pix_charges` (ou tabela equivalente). Ajuste de `apply_asaas_payment` para a regra de crédito único.
- Cálculo de taxa em módulo puro com testes (dinheiro).
- Server Actions: variante de cartão nas duas recargas (zod, sessão, permissão, query, `revalidatePath`, retorno `{ error, id? }`).
- UI: seletor Pix/Cartão, formulário de cartão, seletor de parcelas com total e valor da parcela, nos dois diálogos.
- Documentação: `PRODUCT.md`, `docs/architecture.md`, `docs/operations/` (runbook), `.env.example` se houver nova variável.

## Fora de escopo

- Cartão salvo e cobrança recorrente.
- Mais de 12 parcelas.
- Débito.
- Antecipação de recebível.
- Qualquer fluxo de pagamento que hoje não use Asaas.

## Anti-metas

- Dado de cartão em log, banco ou auditoria.
- Crédito duplicado em parcelamento.
- Taxa errada no total mostrado ao cliente.

## Critérios de aceite

- Recarga com cartão à vista e parcelado credita a carteira uma única vez, nos dois fluxos.
- O total mostrado é igual ao total cobrado, e o líquido do Asaas é igual à recarga (testado nas faixas 1x, 2–6x, 7–12x e nos arredondamentos).
- Cartão recusado não cria cobrança nem crédito.
- Estorno de cobrança de cartão estorna o crédito.
- Teste que prova que nenhum dado de cartão chega a log, banco ou auditoria.
- (post-deploy) Taxas conferidas com a tabela real da conta Asaas.
