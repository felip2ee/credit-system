# Programa de afiliados — design

Data: 2026-10-24. Estado: aprovado pelo dono em 2026-10-24. Depende de: `2026-10-24-dossies-pf-empresarial-design.md`.

### Estado da dependência (2026-10-24)

- O PR #74 (Dossiê PF e Dossiê Empresarial) entrou em `feature/m7-producao` às 16:48:35 UTC (merge `d7d3a17`).
- O PR #71 (`feature/m7-producao` → `main`) entrou 13 segundos antes, às 16:48:22 UTC (merge `7d3dd06`). Por isso a `main` **não** tem o trabalho do PR #74.
- Para levar o PR #74 à `main`, foi aberto o PR #75 (`feature/m7-producao` → `main`, 16 commits, sem conflito), que também fecha a issue #73.
- O PR #75 entrou na `main` em 2026-10-24 (merge `c5f8fc1`). A branch desta entrega, `feature/afiliados`, sai da `main` nesse ponto.

## Intenção

Os clientes finais dos Bureaus passam a vender o produto para outras pessoas e empresas. Cada cliente tem um link de afiliado. Quem se cadastra pelo link e compra gera uma comissão para o afiliado. A comissão entra num saldo que o afiliado saca.

Exemplo: o Felipe manda o link para o João. O João compra R$ 1.000,00; o custo da plataforma é R$ 600,00, então a margem do Bureau é R$ 400,00. A comissão que o Bureau definiu para o Felipe é de 10% da margem. Entram R$ 40,00 no saldo de comissão do Felipe. Depois da carência, ele saca ou converte em créditos.

Motivo: o Bureau ganha canal de venda sem custo fixo, e o cliente ganha motivo para indicar.

## Metas

1. Todo cliente (conta PF ou PJ) tem um link de afiliado no perfil.
2. Um cadastro feito pelo link fica ligado ao afiliado.
3. O Bureau define a % de comissão de cada afiliado.
4. Cada compra online capturada de um indicado gera comissão para o afiliado.
5. A comissão entra num saldo de comissão, separado dos créditos, e fica bloqueada durante a carência.
6. Depois da carência, o afiliado converte o saldo em créditos (sem taxa) ou pede saque do saldo de comissão. O superadmin define a taxa de saque (fixo, %, ou fixo + %). A taxa aparece no perfil do cliente e na tela de saque.
7. Telas:
   - **Afiliado:** tela de afiliação com o link, os indicados, o que compraram, quanto gastaram e a comissão ganha; tela de saque.
   - **Bureau:** tela de afiliados com a % de cada um e o total pago em comissão.
   - **Superadmin:** fila de saques e configuração da taxa.
   - **Saldo ao entrar:** o painel do Bureau e a home do portal mostram o saldo logo no topo.

## Não metas

- Saque automático por PIX. O Asaas não tem transferência de saída integrada hoje (`src/lib/asaas` só cria cobrança e NFS-e). O saque é manual, como o repasse ao Bureau.
- Comissão em pedido de balcão (o cliente paga o Bureau fora da plataforma, e a plataforma não tem esse dinheiro).
- Comissão sobre recarga de créditos. A comissão nasce na compra capturada, não no depósito.
- Afiliação em vários níveis (afiliado do afiliado).
- Afiliação entre Bureaus. O link pertence ao Bureau do afiliado.
- Rastreio por cookie de visita sem cadastro.

## Antimetas (falha mesmo se funcionar)

- A comissão sai do custo da plataforma. Ela sai só da margem do Bureau.
- O afiliado ganha comissão sobre a própria compra.
- A mesma compra gera duas comissões.
- O afiliado vê dados da pessoa ou empresa consultada (CPF, CNPJ, resultado). Ele vê só quem se cadastrou pelo link, o produto e o valor.
- O cliente saca créditos de recarga. Só o saldo de comissão é sacável.
- Um saque deixa o saldo de comissão negativo.

## Regras de negócio

### Vínculo

- O link é `/b/<slug>/cadastro?ref=<código>`. O código é único, curto, não sequencial e não contém dado pessoal.
- O vínculo nasce só no cadastro de uma conta nova, e é permanente (decisão do designer). Conta que já existe não troca de afiliado.
- Autoindicação é recusada (mesmo e-mail, mesmo CPF/CNPJ do titular ou mesmo telefone do afiliado).
- Código inválido, de outro Bureau ou de cliente anonimizado (LGPD) é ignorado. O cadastro continua sem vínculo e sem erro para quem se cadastra.

### Comissão

- **Quando:** na captura de um pedido online de um indicado (`capture_order`), na mesma transação.
- **Base (decisão do dono):** % da margem do Bureau no pedido: `comissão = round(pct × (preço − custo), 2)`, com preço e custo de `order_settlements`. Se a margem é 0 ou a comissão arredonda para 0, não há comissão.
- **De onde sai:** o accrual do Bureau no pedido passa a ser `margem − comissão`. Se o accrual zera (pct = 100%), ele não é gravado (o CHECK exige `amount > 0`).
- **%:** cada Bureau tem uma % padrão (começa em 0%) e pode definir uma % por afiliado, de 0% a 100%. A % vigente na hora da captura é gravada junto da comissão. Mudar a % não altera comissões já gravadas.
- **Idempotência:** chave `order:commission:<order_ref>`. Uma compra gera no máximo uma comissão.
- **Estorno:** o pedido capturado não é estornado, mas a recarga PIX que pagou a compra pode ser (webhook `PAYMENT_REFUNDED`, 019:~405-430). Esse fluxo cobra a falta do accrual do Bureau ainda não repassado (`least(v_shortfall, v_payable)`) e não sabe qual pedido foi afetado. Com comissão, o accrual nasce menor e sobra mais prejuízo em `refund_shortfall`. Regra (decisão do dono): **carência + reversão.**
  - A comissão nasce bloqueada por uma carência em dias (`settings`: `affiliate_commission_hold_days`, padrão 30, definido pelo superadmin). Depois dela, o tick do pedido a libera para o saldo disponível.
  - Quando o estorno de uma recarga deixa falta (`refund_shortfall`) na carteira de um cliente indicado, a falta paga **primeiro com a comissão**: as comissões ainda bloqueadas geradas por pedidos desse cliente são revertidas, da mais nova para a mais antiga, até o valor da falta. **Depois** o Bureau paga o que restar (clawback do accrual ainda não repassado, `least(resto, a repassar)`). O que sobrar dos dois fica em `refund_shortfall`. Tudo na mesma transação do webhook. Ordem de travas: carteira do cliente, carteira do afiliado, comissões; `release_due_commissions` trava a carteira do afiliado antes das comissões dele.
  - Comissão já liberada não é revertida (a plataforma absorve).

### Saldo de comissão

- Carteira própria do afiliado, separada de `client_wallets`: `affiliate_wallets` e `affiliate_ledger_entries`, imutáveis, no mesmo padrão do livro-razão (decisão do designer; manter separado impede sacar crédito de recarga).
- Saldos: `pending` (em carência) e `available` (liberado), ambos `>= 0`.
- Lançamentos: `commission` (crédito em `pending`), `commission_release` (`pending` → `available`), `commission_reversal` (débito em `pending`), `conversion` (débito em `available` para virar crédito), `withdrawal_hold` (reserva no pedido de saque), `withdrawal_paid` (baixa no pagamento), `withdrawal_release` (devolve se o saque é cancelado).

### Conversão em créditos (decisão do dono)

- O afiliado converte qualquer valor do saldo disponível em créditos da própria carteira de cliente, sem taxa.
- Na mesma transação: `conversion` no livro do afiliado e um lançamento novo `commission_credit` em `client_ledger_entries` (CHECK de `kind` e `client_wallet_post_entry` ganham o tipo novo, 018:148).
- Crédito convertido segue as regras dos créditos: não é sacável e não gera NFS-e (não houve pagamento).

### Saque

- O afiliado pede o saque de um valor do saldo disponível, com a chave PIX de destino. O valor fica reservado (`withdrawal_hold`).
- Taxa: definida pelo superadmin em `settings` (`affiliate_withdrawal_fee = { fixed, percent }`). Valor líquido = valor − (fixo + percent × valor), arredondado para centavos. O pedido é recusado se o líquido for ≤ 0.
- Um saque aberto por afiliado por vez (decisão do designer).
- **Flag `AFFILIATE_WITHDRAWALS_ENABLED`:** o saque nasce desligado (`true` liga; ausente ou outro valor desliga) até o contador validar o tratamento fiscal. Desligado, o portal esconde "Sacar por PIX" e mostra "Saque disponível em breve.", e `requestWithdrawalAction` devolve "O saque ainda não está disponível." sem tocar o banco. A conversão em créditos e a fila do superadmin seguem funcionando.
- **Taxa visível ao cliente:** `settings` não é legível pelo cliente (RLS). A função `affiliate_withdrawal_fee()` devolve só a taxa (fixo e %) e é a mesma leitura que o pedido de saque usa para cobrar; o portal mostra a taxa em `/portal/afiliacao` e `/portal/afiliacao/saque`.
- O superadmin vê a fila, paga por fora e marca como pago com comprovante (reuso do padrão de `payouts`: PDF/PNG/JPEG, 5 MB, ClamAV). Ou cancela com motivo, e o valor volta ao saldo.
- A taxa fica com a plataforma.
- **Favorecido:** o saque só vai para uma chave PIX em nome do titular da conta. O afiliado escolhe o tipo (CPF/CNPJ, e-mail, telefone ou aleatória) e marca uma declaração de que a chave é dele. Antes de pagar, o superadmin confere que o nome que o banco mostra para a chave é o nome da conta; se não for, cancela com motivo (decisão do designer). Chave do tipo CPF/CNPJ só vale se for o documento do titular ligado à conta (`holders.client_profile_id`); outra recusa o pedido (`pix_key_not_owner`). O detalhe do superadmin mostra o documento da conta mascarado, para conferir as chaves dos outros tipos. A tabela valida o formato da chave por tipo (CPF 11 ou CNPJ 14 dígitos, e-mail com `@`, telefone E.164, UUID).
- **Chave PIX:** gravada só no pedido de saque. O afiliado vê a chave mascarada. O superadmin vê a chave completa e o nome do titular na fila de saques, porque precisa deles para pagar; cada abertura do detalhe grava auditoria `withdrawal.view` (sem a chave no metadata). Isso não exige modo suporte: é dado do próprio afiliado, dado para receber, e não dado de consulta (decisão do designer). A chave nunca vai para log ou auditoria. Retenção LGPD igual à dos comprovantes de repasse.
- **Anonimização (LGPD, 023):** a anonimização da conta de um afiliado fica bloqueada enquanto houver comissão **disponível** > 0 ou saque aberto; a mensagem diz que o cliente precisa sacar antes. A comissão **ainda em carência é perdida** na anonimização: cada comissão pendente é revertida (lançamento `commission_reversal`, chave `lgpd:<comissão>`, auditoria `affiliate.forfeit` sem documento). A carteira do afiliado é travada antes da checagem, e a captura de pedido lê o perfil do afiliado com `for share`: a comissão nunca nasce depois da anonimização. A perda da comissão pendente é decisão do designer; validar com o jurídico. Depois de anonimizado, o afiliado não recebe novas comissões (o vínculo antigo fica só para histórico) e a chave PIX dos saques pagos segue a retenção dos comprovantes (decisão do designer; validar com o jurídico).

### Saldo ao entrar

- **Portal:** a home mostra o saldo de créditos e o saldo de comissão (disponível e em carência).
- **Bureau:** o painel mostra o saldo da carteira pré-paga e o valor a receber (accrual em aberto).

## Restrições

- Migration nova `026_*` (as anteriores já estão em uso pela entrega do PR #74; se a base ainda for editável no momento, siga a política do `PRODUCT.md`).
- Dinheiro só por funções de lançamento, livro-razão imutável, auditoria na mesma transação.
- Toda tabela nova com RLS (`enable` + `force`) e caso em `src/lib/db/rls.integration.test.ts`.
- Afiliado vê só os próprios indicados; Bureau vê só os próprios afiliados; superadmin vê a fila de saques com chave e nome do favorecido, com auditoria de leitura.
- Textos em pt-BR. Atualizar `PRODUCT.md` (tirar "comissão" de "Fora de escopo").

## Decidido pelo dono

- Todo cliente, PF ou PJ, tem link de afiliado.
- O Bureau controla a % de cada afiliado.
- A comissão vai para um saldo que o afiliado saca.
- O superadmin define a taxa de saque: fixo, %, ou fixo + %. A taxa aparece no perfil.
- Telas de afiliação, de saque e de afiliados do Bureau; saldo visível ao entrar.
- Quem quer consultar outra pessoa manda o link de afiliado, e a pessoa consulta na própria conta (decisão da spec dos dossiês).
- Comissão = % da margem do Bureau no pedido.
- Carência antes do saque, com reversão da comissão bloqueada se a recarga for estornada.
- O saldo de comissão pode ser sacado ou convertido em créditos.
- Pedido de balcão não gera comissão.

## Decisões do designer (o dono pode corrigir)

- Vínculo só no cadastro, permanente.
- Saldo de comissão separado e só sacável.
- Saque manual, um aberto por vez.
- % padrão do Bureau começa em 0%.

## Pendência externa

1. Fiscal: a plataforma vai pagar pessoas físicas. Isso pode exigir retenção de imposto ou recibo (RPA). Precisa de validação do contador antes de abrir o saque.

## Deixado ao builder

- Formato do código do link e onde ele fica (coluna em `profiles` ou tabela própria).
- Layout das telas.
- Como o painel do Bureau soma o valor a receber.

## Afeta

- Cadastro: `src/app/b/[slug]/cadastro/page.tsx` (ler `searchParams.ref`), `src/actions/register.ts`, `register_client` (021:245; nova assinatura).
- Liquidação: `capture_order` vigente em 019:132 (comissão logo depois do accrual).
- Configuração: `settings` (003:289), `src/lib/settings/`.
- Comprovante: `src/lib/payouts/receipt.ts` (reuso).
- Painéis: `src/app/(dashboard)/page.tsx`, `src/lib/dashboard/queries.ts`, `src/app/(portal)/portal/page.tsx`, `src/lib/wallet/client-queries.ts`.

## Critérios de aceitação

- [ ] Teste: cadastro com `ref` válido do mesmo Bureau cria o vínculo; `ref` de outro Bureau, inválido ou autoindicação → cadastro sem vínculo.
- [ ] Teste: compra online capturada de indicado com 10%, preço R$ 1.000,00 e custo R$ 600,00 gera comissão R$ 40,00 em carência e accrual do Bureau R$ 360,00.
- [ ] Teste: pct 100% → comissão = margem, accrual não é gravado; margem 0 → sem comissão.
- [ ] Teste: comissão só fica disponível depois de `affiliate_commission_hold_days`; saque e conversão recusam valor em carência.
- [ ] Teste: estorno de recarga com falta de R$ 30,00 de um indicado reverte R$ 30,00 das comissões em carência dele e reduz o `refund_shortfall`; comissão já liberada não é revertida.
- [ ] Teste: conversão de R$ 40,00 debita o saldo de comissão e credita R$ 40,00 na carteira de créditos, sem taxa.
- [ ] Teste: captura repetida não gera segunda comissão; pedido de balcão e pedido do próprio afiliado não geram comissão.
- [ ] Teste: saque com taxa fixo R$ 2,00 + 1% sobre R$ 100,00 → líquido R$ 97,00; saque com líquido ≤ 0 recusado; segundo saque aberto recusado; cancelamento devolve o saldo.
- [ ] Teste: o afiliado não lê indicados nem comissões de outro afiliado; o Bureau não lê afiliados de outro Bureau.
- [ ] O afiliado não vê documento nem resultado de consulta dos indicados.
- [ ] Home do portal e painel do Bureau mostram os saldos.
- [ ] `npm run check` verde.
- [ ] (post-deploy) Contador valida o tratamento fiscal do saque antes de liberar a funcionalidade.
