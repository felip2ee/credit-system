# Carteira: reorganização para o dono do Bureau

Data: 2026-10-26. Estado: rascunho para aprovação. Escrito em pt-BR.

## Intenção

O dono do Bureau abre a Carteira para entender o dinheiro. Ele quer saber, para cada venda, quanto o cliente final pagou, quanto era a sua parte e como o pagamento aconteceu. Hoje a Carteira mistura três coisas diferentes sem explicar. O extrato mostra termos técnicos. A tela de detalhe do pedido mostra "Falta R$ 300" num pedido online que o cliente já pagou pelo app.

Sucesso: o dono olha cada aba e entende, sem ajuda, o que ela mostra. Quando um pedido aparece em duas telas, as duas dizem a mesma coisa.

## Os três dinheiros (modelo mental)

1. **Saldo pré-pago do Bureau.** Dinheiro que o Bureau colocou na Rainha Cred (recarga por Pix). Paga o custo dos pedidos de balcão. Tabela `ledger_entries`.
2. **Saldo do cliente.** Dinheiro que o cliente final colocou no portal. Paga os pedidos online. Tabela `client_ledger_entries`. Não é dinheiro do Bureau.
3. **A receber.** A parte do Bureau nos pedidos online: preço menos custo. A Rainha Cred repassa. Tabela `bureau_payable_entries`.

Pedido online: o cliente paga o preço com o saldo dele; o Bureau ganha (preço − custo) em "A receber". O saldo pré-pago do Bureau não muda.
Pedido de balcão: o Bureau recebe o preço do cliente por fora (dinheiro, Pix, maquininha); o custo sai do saldo pré-pago do Bureau.

Esta regra contábil não muda. O trabalho é de exibição, mais a retenção dos 30 dias.

## Metas

- Abas da Carteira: **Pedidos online**, **Balcão**, **Extrato total**, **A receber e saques**. Cada aba tem uma frase curta no topo que diz o que ela mostra.
- Os cartões do topo continuam: "Saldo pré-pago" e "A receber", cada um com uma frase de explicação.
- **Pedidos online** e **Balcão**: uma linha por venda com o nome do titular, o produto, a data, quanto o cliente pagou, o custo, a parte do Bureau e a situação. Total do período no fim, com os mesmos filtros de período do Dashboard (`src/lib/dashboard/period.ts`).
- **Extrato total**: todas as movimentações dos três dinheiros, em ordem de data, uma lista só. Cada linha diz o que aconteceu, de onde veio e para onde foi, em português simples. Filtro: Tudo, Saldo pré-pago, A receber. Exemplo de texto: "Crédito dado a cliente. Saiu do saldo do Bureau e entrou no saldo do cliente (ajuste de conta)." Nada que movimentou fica de fora. O saldo do cliente do ajuste aparece como parte da linha do ajuste, não como uma segunda conta.
- **Detalhe do pedido** (`/settings/counter-payments?dossier=`): vale para os dois modos. Online: mostra "Pago pelo app (saldo do cliente)", valor pago, custo, parte do Bureau, "Quitado", e esconde o formulário de pagamento de balcão. Balcão: mostra pagamentos registrados, quanto falta, parte do Bureau, e mantém o formulário.
- **A receber e saques** tem três números: Disponível para saque, Em liberação (cada valor com a data em que libera) e Já repassado. Abaixo, a lista de lançamentos e o histórico de repasses.

## Retenção de 30 dias

- Cada lucro de pedido online fica retido por 30 dias, contados da conclusão do pedido (decisão do dono do produto: "dinheiro fica retido por padrão 30 dias". Contar da conclusão é minha suposição).
- O prazo é uma configuração do superadmin, uma só para todos os Bureaus. O padrão é 30 dias. Fica em `/superadmin/settings/`, junto das outras configurações globais.
- Estorno durante a retenção tira o valor de "Em liberação".
- Disponível para saque = soma dos lançamentos já liberados menos o que já foi repassado.

## Não metas

- Não mudar como o dinheiro é lançado (funções SQL `capture_order`, `reserve_order`, carteiras).
- Não criar um novo fluxo de saque por Pix para o Bureau além do que já existe em Repasses, a menos que o item abaixo exija.
- Não mexer na carteira nem nos saques dos afiliados.
- Não mostrar CPF/CNPJ completo em nenhuma linha.

## Anti-metas (falharia mesmo que funcionasse)

- Duas telas dizendo coisas diferentes sobre o mesmo pedido.
- Nome técnico (`reserve`, `capture`, `notification`) em qualquer tela do dono.
- Um valor aparecer em "Disponível para saque" e ainda estar dentro dos 30 dias.

## Restrições

- Next.js 14, `pg` com SQL puro, `withUserTransaction`, RLS. Migração nova em `db/migrations/NNN_nome.sql` (próximo número livre depois da 034; nunca editar migração aplicada).
- `order_settlements.cost` não é legível pelo papel `app_runtime` por coluna. A função `order_settlement_cost()` (018) devolve custo e cotação à equipe do Bureau dono. O custo por pedido vem dela.
- Mobile a partir de 360px, alvos de 44px, textos pt-BR em linguagem simples.
- Trabalho em paralelo: outro agente está com a migração `034_push_notifications.sql` e vai commitar. Este plano só executa depois desse commit.

## Já feito nesta sessão (base)

Carteira com dois cartões e abas Extrato, A receber e Pagamentos de balcão; extrato com `src/lib/wallet/ledger-view.ts`; lista de pagamentos com forma de pagamento (`src/lib/counter-payments/overview.ts`); auditoria em português (`src/lib/audit/labels.ts`).

## Fica com quem constrói

- Estrutura das consultas e se o extrato total é uma consulta única ou a união de três.
- Como guardar a data de liberação (coluna calculada no lançamento ou cálculo na leitura com a configuração).
- Nomes de componentes e arquivos; testes.

## Decisões minhas para o dono conferir

- Contar os 30 dias da conclusão do pedido.
- Chave da configuração e tela no superadmin.
- Quem pede o saque: manter o fluxo atual de Repasses (superadmin paga) e só mostrar "Disponível para saque" como informação. Se o Bureau precisa pedir o saque pela tela, isso é um item novo.

## Respostas após a revisão do design

Respondidas pelo projeto:
- Conclusão do pedido: o lançamento de "A receber" nasce na mesma transação que captura o pedido (`capture_order`, 018). A data de criação do lançamento é a data de conclusão. Não precisa de coluna nova para isso.

Decisões minhas (o dono pode mudar):
- A data de liberação é calculada na leitura: data do lançamento + prazo da configuração. Mudar o prazo muda todos os lançamentos pendentes. Lançamentos antigos seguem a mesma regra: os que já têm mais que o prazo ficam liberados no primeiro deploy.
- Estorno depois da liberação: aparece como lançamento negativo em "A receber". "Disponível para saque" nunca mostra valor abaixo de zero; o estorno abate dos próximos lucros.
- Extrato total: uma linha por ajuste de conta. Se não existir chave comum entre `ledger_entries` e `client_ledger_entries`, o construtor propõe uma regra de ligação (mesma transação e valor) ou uma migração para guardar a chave. Paginado, 50 linhas por página, com o mesmo filtro de período.
- Pedidos online e Balcão: pedido cancelado ou devolvido continua na lista, com o status, e fica fora dos totais. "Quanto o cliente pagou" no balcão é a soma dos pagamentos não anulados.

## Decisão do dono sobre o bloqueio

A retenção bloqueia de verdade. A criação de um repasse é recusada, no banco, se o valor passar do "Disponível para saque" do Bureau. A tela e o pagamento real usam o mesmo cálculo. É uma tarefa própria, com testes de dinheiro: repasse dentro do disponível passa; repasse acima do disponível é recusado com motivo claro; lançamento dentro dos 30 dias não conta; repasses simultâneos não passam do limite juntos.
