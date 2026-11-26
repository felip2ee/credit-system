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

- `placeOrder` online em duas fases: (1) cria o pedido em `awaiting_payment` com preço e cupom guardados, sem `reserve_order`; (2) cria o PIX Asaas ligado ao pedido (`external_reference` = chave de idempotência).
- Migration nova: vínculo `pix_charges.order_id` (ou equivalente), com RLS e grants. Relaxar apenas o que for necessário em `pix_charges_link_shape_check`.
- Webhook: ramo novo em `apply_asaas_payment` para PIX com pedido. Na mesma transação: credita a carteira com o valor pago, chama `reserve_order` com o preço guardado, chama `refresh_order_state`. Idempotente.
- `refresh_order_state`: ramo online (hoje `awaiting_payment` só existe no balcão).
- Valor do PIX vem do servidor e deve igualar o preço guardado. Valor menor não reserva nada.
- Preço zero (cupom): sem PIX, vai direto para a reserva.
- PIX vencido cancela o pedido. Teto de R$ 5.000 herdado da recarga: se o preço passar disso, mostrar erro claro.
- Falha de reserva após pagamento: valor fica como saldo, pedido marcado com motivo, mensagem em pt-BR.
- Tela: `/portal/pesquisas/[id]/pagar`, reaproveitando QR e `useChargePolling`. Ao pagar, redireciona ao pedido.
- Testes: integração com Postgres para webhook repetido, valor errado, cupom esgotado e preço zero.

### Parte 3. Compra em etapas e densidade

- Etapa 1: escolha "só para mim" ou "para uma empresa". Define `holderType` e `self`.
- Etapa 2 (empresa): dados da empresa. Etapa 3: pessoas (o próprio comprador, sócios, cônjuges), cada uma com nome, CPF e e-mail. Etapa de revisão com a lista e o valor. Depois, a tela de pagamento da parte 2.
- Limite de pessoas: `MAX_PARTNERS` (`src/lib/validators/order.ts`).
- Sem mudar `open_order`, se o comprador já puder entrar como membro (a verificar: comportamento de `self` em empresa, migration 055).
- Densidade: classe de escopo no portal. Base 16 px (`globals.css:93`), `p-6` vira `p-4` nos cards, espaçamentos menores. Botões e campos mantêm 44 px no celular (`docs/design.md:53`, `e2e/mobile.spec.ts`).
- Divide `client-order-form.tsx` (345 linhas) em componentes por etapa.

### Parte 4. Aba de autorização

- Mostrar e-mail mascarado e status por pessoa (`OrderMember`, `listMyOrderMembers`).
- Nova ação do cliente: editar o e-mail de uma autorização `pending` e reenviar. zod, sessão, permissão, escopo do pedido por RLS, evento de auditoria na mesma transação. Pode precisar de função SQL, porque a RLS atual de `scr_authorizations` restringe o cliente.
- Botão de reenviar sem editar. Autorização já `authorized` ou `refused` não edita.

## Restrições

Regras do `AGENTS.md`: SQL parametrizado, `withUserTransaction`, auditoria na mesma transação, CPF/CNPJ mascarado em logs, textos de interface em pt-BR, migrations numeradas e nunca editadas.

## Pontos para o construtor

- Confirmar `self` dentro de empresa em `open_order` (055).
- Confirmar nome do motivo de saldo insuficiente e mensagens em `CLIENT_ORDER_MESSAGES`.
- Ler `runCheckout` e `CheckoutForm` antes de reaproveitar.
- Escolher a forma do vínculo PIX-pedido (coluna nova em `pix_charges` é a sugestão).
