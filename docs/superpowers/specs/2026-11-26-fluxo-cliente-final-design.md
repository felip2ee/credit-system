# Fluxo do cliente final: cadastro, compra, pagamento e autorização

Data: 2026-11-26. Tamanho: projeto com 4 partes independentes. Cada parte tem seu plano e seu PR.

## Intenção

O cliente final deve entender o que compra e seguir a jornada sem voltar atrás.
Hoje ele confirma e-mail no cadastro e depois confirma o SCR (duas confirmações seguidas).
O formulário de compra é único e longo. Sem saldo, ele recarrega e preenche tudo de novo.
A tela é grande demais.

## Objetivos

1. Cadastro sem confirmação de e-mail.
2. Pagamento por pedido: o cliente preenche tudo, o sistema calcula o valor e abre a tela de PIX. Após o pagamento, o pedido roda sozinho. Sem recarga prévia, sem preencher de novo.
3. Compra em etapas. A primeira etapa é uma escolha clara: "só para mim" ou "para uma empresa". Na empresa, o comprador adiciona a si mesmo, sócios e cônjuges, cada um com e-mail próprio, e confirma a lista antes de pagar.
4. Aba de autorização: mostra quem autorizou e quem não. O comprador corrige o e-mail de quem está com e-mail errado (e reenvia o pedido de autorização).
5. Portal mais denso (fonte base 16 px, menos espaçamento).

## Não objetivos

- Não mudar o modelo de carteira, captura, comissão de afiliado ou cupom.
- Não criar o papel "cônjuge" no banco: ele entra como sócio comum.
- Não mudar o fluxo do balcão nem os links `/pagar/<token>`.
- Não mexer no admin (escala compacta já existe lá).

## Anti-objetivos

- Dinheiro cobrado sem pedido rodando, ou pedido rodando sem pagamento confirmado.
- Cobrança duplicada por webhook repetido.
- Cliente editando e-mail de autorização de pedido que não é dele.

## Abordagens de pagamento (decisão do usuário: A)

- **A. PIX do pedido credita a carteira e reserva.** O webhook credita o valor pago e roda `reserve_order`. Livro de movimentações e captura ficam intactos. Se a reserva falhar após o pagamento, o valor fica como saldo do cliente.
- B. Reusar `payment_links`. Rejeitada: feito para balcão, travas do banco rígidas.
- C. Pagamento direto sem carteira. Rejeitada: muda captura, estorno e comissão; maior risco em dinheiro sem ganho visível.

## Ordem de entrega

### Parte 1. Cadastro sem e-mail (pequena)

- Parar de enviar o e-mail de confirmação no cadastro (`register_client`, migration nova; nunca editar a 021).
- Remover os guards de e-mail verificado: `src/actions/orders-client.ts:28,84`, `src/lib/payments/checkout.ts:79,143`, `src/actions/credits-topup.ts`, `src/app/(portal)/portal/credits/page.tsx:63`.
- Remover o banner do layout do portal (`src/app/(portal)/layout.tsx:33`). Chamada minha: sem envio no cadastro, o banner perde o sentido. A página `/cadastro/confirmar-email` continua para links antigos.
- Ajustar testes: `orders-client`, `register*`, `account*`, `checkout*`, `portal.integration`, `e2e/global-setup.ts`.
- Risco aceito: o e-mail do cadastro deixa de provar posse. A posse que importa é provada pelo SCR de cada pessoa.

### Parte 2. Pagamento por pedido (dinheiro, revisão final com opus)

Plano: `docs/superpowers/plans/2026-11-26-fluxo-cliente-2-pagamento-por-pedido.md`. Esta seção foi corrigida contra o código.

- `placeOrder` online tenta a reserva como hoje. Saldo que cobre o preço (ou preço zero com cupom): reserva direta, sem PIX. Só `insufficient_balance` muda: o pedido fica em `awaiting_payment` e o preço pago e o cupom ficam em `order_pix_quotes` (tabela nova; `dossier_orders` não aceita colunas mutáveis novas sem mudar `open_order`).
- `open_order` não muda: ele já chama `refresh_order_state`, e o ramo online novo de `refresh_order_state` (pago = liquidação `reserved` ou `captured`) põe o pedido sem reserva em `awaiting_payment`.
- Vínculo: `pix_charges.order_id` → `order_pix_quotes`. `pix_charges_link_shape_check` NÃO muda (a cobrança do pedido tem `payment_link_id` nulo). Política restritiva: cobrança de pedido só com o valor guardado.
- O PIX é criado por `runCheckout` (mesmo pagador, taxa, NFS-e e polling da recarga), com o valor lido do banco, nunca do navegador.
- Webhook: função nova `apply_order_pix_charge`, chamada por `apply_asaas_payment`. `reserve_order` exige contexto de cliente (`app.user_id`, `app.user_role`, `app.bureau_id`): o webhook não tem sessão, então a função monta esse contexto local, usa uma vaga de cupom (054) e o restaura. Estorno segue o ramo de estorno existente (carteira do cliente e retomada da reserva).
- Valor menor que o esperado: nada é creditado (`amount_mismatch`, regra da recarga). Valor maior: credita o preço (regra da recarga).
- Falha da reserva depois do pagamento: o preço fica como saldo e o tick cancela o pedido com o motivo novo `payment_not_reserved`.
- PIX vencido (30 min + 15 min de folga) cancela o pedido pelo tick com `payment_timeout`. `cancelOrder` passa a aceitar pedido online sem liquidação.
- Limites do PIX: R$ 10,00 a R$ 5.000,00 (`pix_charges.amount`). Fora disso e sem saldo: erro claro, nada é gravado.
- Tela: `/portal/pesquisas/[id]/pagar`, com QR feito do código copia e cola e `useChargePolling`. Ao pagar, vai ao pedido.

### Parte 3. Compra em etapas e densidade

Plano: `docs/superpowers/plans/2026-11-26-fluxo-cliente-3-compra-em-etapas.md`.

- Etapa 1: escolha "só para você" ou "para uma empresa". Define `productCode`. `self` sai de `isSelfOrder(productCode, holderType)`. O `holderType` vem da conta, não da escolha.
- Empresa: etapa de dados da empresa; etapa de pessoas (o próprio comprador, sócios, cônjuges), cada uma com nome, CPF e e-mail próprio; etapa de revisão com a lista e o valor. Depois, a tela de pagamento da parte 2.
- Limite de pessoas: `MAX_PARTNERS` (`src/lib/validators/order.ts`). O comprador conta como uma linha. E-mail repetido na lista é recusado.
- Comprador como membro, sem mudar `open_order` (verificado na migration 055, regra D12): vale para conta PF. Ele entra como sócio comum, com o próprio CPF e o próprio e-mail. Conta PJ ou sem Titular não pode: o servidor devolve `contact_is_buyer`, e a tela esconde o botão.
- Densidade: classe de escopo `.portal-dense` só no layout do portal, com a variante Tailwind `dense:`. `.area-portal` não muda: ela também vale para auth, onboarding e páginas públicas. Base 16 px, `p-4` nos cards, espaçamentos menores. Botões e campos de 44 px (hoje 48 px no portal; o piso do projeto é 44 px, `e2e/mobile.spec.ts`). `docs/design.md` é atualizado.
- Divide `client-order-form.tsx` (345 linhas) em componentes por etapa. Os passos ficam em `order-wizard-steps.ts` (`order-steps.ts` já é dos passos do pedido pago).

### Parte 4. Aba de autorização

- Mostrar e-mail mascarado e status por pessoa. Hoje `client_order_members` (025) não devolve e-mail nem o id da consulta: a função muda (drop e create, migration nova). A tela continua sendo a seção "Autorizações" da página do pedido, não uma aba nova.
- Nova ação do cliente: corrigir o e-mail de uma autorização e reenviar. Só função SQL `SECURITY DEFINER` serve: o cliente não tem política em `scr_authorizations` (004) e uma política nova exporia `public_token` e `auth_code`. O escopo é a posse do pedido (`dossier_orders.client_profile_id = app_user_id()`), conferida na função, nunca só pelo id da autorização. A RLS não faz esse escopo.
- Não se escreve mecanismo novo. `update_order_contact` (044) já gira `public_token`, apaga `auth_code`, anula a notificação em fila, limita (2 min e 5 por 24 h em `contact_changes_at`) e audita com e-mail mascarado. É só para a equipe. A parte 4 cria a função do cliente com as mesmas regras, mais estritas (3 por 24 h). O e-mail novo sai pelo tick de pedidos (cron de 10 s), sem envio na ação.
- Só autorização `pending` com prazo aberto edita, em pedido `awaiting_payment` ou `awaiting_authorization`. `expired` não edita: o tick cancela o pedido com `scr_expired`. `authorized` e `refused` não editam. Reenviar sem editar vale só em `awaiting_authorization`.
- Duas ações: corrigir (e-mail obrigatório) e reenviar (sem e-mail). E-mail em branco nunca vira reenvio.

## Restrições

Regras do `AGENTS.md`: SQL parametrizado, `withUserTransaction`, auditoria na mesma transação, CPF/CNPJ mascarado em logs, textos de interface em pt-BR, migrations numeradas e nunca editadas.

## Pontos para o construtor

- Confirmar `self` dentro de empresa em `open_order` (055).
- Confirmar nome do motivo de saldo insuficiente e mensagens em `CLIENT_ORDER_MESSAGES`.
- Ler `runCheckout` e `CheckoutForm` antes de reaproveitar.
- Escolher a forma do vínculo PIX-pedido (coluna nova em `pix_charges` é a sugestão).
