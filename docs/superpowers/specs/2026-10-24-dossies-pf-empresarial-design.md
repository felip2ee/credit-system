# Dossiê Pessoa Física e Dossiê Empresarial Estruturado — design

Data: 2026-10-24. Estado: aprovado pelo dono em 2026-10-24.

## Intenção

O catálogo atual tem 3 produtos principais (`consulta_pf`, `consulta_pj`, `dossie_pj_completo`) e um adicional vendido à parte (`parecer_ia`). O preço é um valor único por produto, qualquer que seja o número de sócios. Isso não corresponde ao que o dono quer vender.

O produto novo tem duas ofertas:

- **Dossiê Pessoa Física**: um CPF.
- **Dossiê Empresarial Estruturado**: uma empresa (CNPJ) e de 0 a N sócios (CPF).

Toda consulta já inclui o parecer IA. O preço da oferta empresarial é um valor fixo da empresa mais um valor por sócio. Isso vale para o custo (plataforma → Bureau) e para a venda (Bureau → cliente final).

Motivo: o custo real da plataforma cresce com cada CPF consultado na DEPS. Um preço único dá prejuízo em pedidos com muitos sócios e afasta pedidos sem sócios.

## Metas

1. O catálogo tem só 2 produtos principais: Dossiê Pessoa Física e Dossiê Empresarial Estruturado.
2. O parecer IA roda em toda consulta concluída. Ele não é mais um produto, um adicional nem um checkbox.
3. Custo e venda têm o formato:
   - Dossiê Pessoa Física: `valor_base`.
   - Dossiê Empresarial: `valor_base` (empresa) + `valor_por_socio` × número de sócios.
4. O superadmin define o custo por Bureau nos dois campos. O Bureau define a venda nos dois campos.
5. O balcão usa a mesma fórmula: o operador escolhe de 0 a 20 sócios e o total muda com o número.
6. O portal oferece as duas ofertas a qualquer conta de cliente (PF ou PJ).
7. No portal, o Dossiê Empresarial convida cada sócio por e-mail. O cliente vê quem aceitou e quem falta. O cliente pode cancelar e recebe o valor reservado de volta.

## Não metas

- Programa de afiliados (spec separada; veja "Relação com a próxima spec").
- Editar a lista de sócios depois de abrir o pedido. Para mudar, o cliente cancela e abre outro pedido.
- Reenviar convite ou trocar um sócio dentro do mesmo pedido.
- Dossiê Pessoa Física de terceiro no portal. O fluxo "terceiro" do portal sai (única exceção: o responsável da conta PJ). Quem quer consultar outra pessoa manda o link de afiliado e ela compra na própria conta.
- Descoberta automática dos sócios pela DEPS (QSA). O cliente ou o operador informa os sócios.
- Mudar a NFS-e. A nota sai em nome do tipo da conta (PF ou PJ), definido no cadastro, como hoje.

## Antimetas (falha mesmo se funcionar)

- Um pedido cobra um total diferente do que o cliente ou o operador viu na tela antes de confirmar.
- Um pedido com N sócios reserva o preço de outro N.
- Uma consulta roda antes de todos os membros autorizarem o SCR.
- Um cancelamento deixa saldo reservado preso.
- O parecer IA aparece como item pago à parte em qualquer tela, PDF ou extrato.

## Regras de negócio

### Preço

- Os dois campos são `numeric(15,2)`. Venda: `valor_base > 0` (o `reserve_order` recusa total zero) e `valor_por_socio >= 0`. Custo: os dois `>= 0`. Para o Dossiê Pessoa Física, `valor_por_socio` não se aplica (fica nulo ou 0; escolha do builder, mas a fórmula nunca o usa).
- Total do pedido = `valor_base + valor_por_socio × n_socios`, com `n_socios` = número de sócios distintos (por documento) no pedido. Sócio repetido conta uma vez, como hoje em `open_order`.
- Venda e custo são conferidos no banco: `reserve_order` recalcula os dois totais pelo catálogo do Bureau e pelo `n_socios` do pedido, e recusa se o valor enviado for diferente (mesma defesa de hoje).
- Regra `preço >= custo`: vale por campo (`venda.valor_base >= custo.valor_base` e `venda.valor_por_socio >= custo.valor_por_socio`). Assim o total nunca fica abaixo do custo para nenhum N. O formulário do Bureau mostra o erro por campo.
- `order_settlements.quote` guarda as linhas congeladas: uma linha da empresa (ou do CPF, no PF) e uma linha "sócios" com quantidade e valor unitário. A tela e o extrato leem dessas linhas.
- O custo do parecer IA fica dentro do `valor_base`. Não há linha própria.

### Execução DEPS (sem mudança de comportamento)

- Dossiê Pessoa Física: DEPS "Smart PF 002".
- Dossiê Empresarial: a empresa usa "Smart PJ 010"; cada sócio usa "Smart PF 002". Hoje isso já é assim para `dossie_pj_completo`.
- Se a consulta da empresa falha, o pedido falha e a reserva é liberada (como hoje). Se um sócio volta sem dados, a consulta dele fica `error`, o dossiê termina com erros e o pedido é capturado inteiro (como hoje).

### Parecer IA

- Todo pedido entra com o parecer pendente. O tick gera o parecer depois da conclusão, como hoje (`src/lib/orders/tick-queries.ts`, `src/lib/orders/ai.ts`).
- Saem: produto `parecer_ia`, `kind = 'addon'`, `addon_for`, o checkbox `withAi` no balcão e no portal, e a linha de adicional na cotação.

### Balcão

- O operador escolhe a oferta. No Dossiê Empresarial, informa a empresa e de 0 a 20 sócios (nome, documento, e-mail obrigatório; papel e % opcionais), como hoje no formulário de `dossie_pj_completo`.
- A tela mostra o total ao vivo conforme o operador adiciona ou remove sócios.
- O cliente paga o Bureau no balcão (`counter_payments`) pelo total de venda. A carteira pré-paga do Bureau reserva o total de custo. Não há repasse no balcão (como hoje).

### Portal

- **Dossiê Pessoa Física**:
  - Conta PF: só o próprio cliente. Usa o titular da conta (`self`). Não há campo de documento de terceiro.
  - Conta PJ: informa o CPF, o nome e o e-mail do responsável pela empresa. O responsável dá o aceite SCR. É a única exceção ao "sem terceiro".
- **Dossiê Empresarial**: para qualquer CNPJ informado, por conta PF ou PJ. Nada roda sem o aceite SCR do responsável da empresa e de cada sócio.
  1. O cliente informa o CNPJ e o e-mail do responsável da empresa, e cada sócio com nome, CPF e e-mail (de 0 a 20). Sócio é sempre CPF (11 dígitos); o banco e o zod recusam CNPJ como sócio.
  2. A tela mostra o total e confirma. O total é reservado da carteira do cliente.
  3. Cada membro recebe o pedido de autorização SCR por e-mail (o fluxo atual por membro, validade de 7 dias). Se o próprio cliente for sócio ou responsável, ele também autoriza pelo link do e-mail.
     - **Decisão do dono (trava por CPF):** no portal, o e-mail de um membro pode ser igual ao e-mail do comprador **só quando o documento desse membro é igual ao documento do titular da conta do comprador**. Em qualquer outro caso, `open_order` continua recusando com `contact_is_buyer` (regra D12). No balcão, a D12 não muda. A checagem fica no banco (`open_order`), não só na action.
     - O evento de auditoria da autorização registra quando o membro é o próprio comprador.
     - **Declaração do comprador (decisão do dono):** antes de confirmar um pedido com membros (Dossiê Empresarial, ou Dossiê Pessoa Física do responsável da conta PJ), o cliente marca um checkbox obrigatório. O texto declara que os e-mails informados pertencem às pessoas indicadas e que ele responde por informação falsa. O aceite é gravado por pedido, com a versão do texto, na mesma transação do pedido. Reutilize o aceite versionado da 021 (`legal_documents`, `legal_acceptances`) com um tipo de documento novo. Os Termos de Uso ganham a cláusula correspondente (nova versão em `legal_documents`). O texto jurídico final vem do advogado do dono; o builder usa um texto provisório marcado como tal.
  4. A página do pedido lista cada membro com o estado da autorização: pendente, autorizado, recusado, vencido.
  5. Quando todos autorizam, o pedido fica `ready` e roda no próximo tick (comportamento atual de `refresh_order_state`).
  6. Antes de rodar (`awaiting_authorization` ou `ready`), o cliente pode cancelar. A reserva volta para a carteira dele.
- Se um membro recusa ou deixa vencer, o pedido não roda. A página mostra isso e oferece o botão de cancelar.
- Pré-requisitos atuais continuam: termos aceitos e e-mail verificado.

### Cancelamento pelo cliente

- Ação nova do cliente, só do dono do pedido, só nos estados `awaiting_authorization` e `ready`.
- Usa a liberação existente (`release_order`) e grava evento de auditoria na mesma transação. Motivo novo: `cancelled_by_client`.
- O banco checa a posse do pedido (RLS ou a própria função), não só a action.

## Restrições

- Sem produção no ar: `db/migrations/` ainda é base editável (política do `PRODUCT.md`). Não há pedidos a preservar; o banco local foi zerado em 2026-10-24. O builder pode reescrever as migrations 010 e 022 (e recriar o banco com `npm run db:reset`) sem migração de dados.
- Dinheiro só por `wallet_post_entry` / `client_wallet_post_entry`, livro-razão imutável, auditoria na mesma transação.
- Toda tabela ou coluna nova com RLS e caso em `src/lib/db/rls.integration.test.ts`.
- Textos de interface em pt-BR. Nomes exibidos: "Dossiê Pessoa Física" e "Dossiê Empresarial Estruturado".
- Padrões do `AGENTS.md`: zod, `withUserTransaction`, `hasPermission`, `{ ok: false, reason }`.

## Decidido pelo dono

- 2 produtos com os nomes acima; PJ com 0 a N sócios.
- Parecer IA embutido, nunca vendido à parte.
- Custo e venda = fixo da empresa + valor por sócio; o superadmin define o custo e o Bureau define a venda.
- Qualquer conta (PF ou PJ) compra as duas ofertas.
- No portal, o cliente informa o e-mail de cada sócio, acompanha os aceites, roda depois de todos aceitarem e pode cancelar com estorno.
- Mudou algo depois de abrir? Cancela o pedido inteiro e abre outro.
- Portal sem consulta de terceiro, exceto o responsável da conta PJ no Dossiê Pessoa Física.
- Dossiê Empresarial no portal para qualquer CNPJ informado.
- No portal, o e-mail de um membro pode ser igual ao do comprador só quando o CPF do membro é o CPF da conta do comprador (trava por CPF). Nos outros casos, a D12 continua.
- Checkbox obrigatório de declaração do comprador em pedido com membros, e cláusula nos Termos de Uso.

## Chamadas do designer (o dono pode corrigir)

- Sócio é sempre CPF. Sócio CNPJ (holding) fica fora desta entrega.
- Venda `valor_base > 0`; custo pode ser 0.
- O item 18 da issue #72 (consulta presa em "Aguardando SCR" depois da autorização) entra neste plano como primeira tarefa e sai da #72.

- A consulta roda sozinha no tick quando todos autorizam. O cliente não aperta um botão de "rodar". (Comportamento atual.)
- No portal, o Dossiê Empresarial aceita 0 sócios, igual ao balcão.
- Limite de 20 sócios, o mesmo de hoje (`MAX_PARTNERS`).
- `preço >= custo` checado por campo, não só no total.
- Sem reenvio de convite nesta entrega.
- Sócio sem dados na DEPS não estorna a parte dele (comportamento atual).

## Deixado ao builder

- Códigos internos dos produtos (ex.: `dossie_pf`, `dossie_empresarial`) e como migrar os códigos atuais.
- Onde ficam os dois campos de preço (`product_versions`, `bureau_product_costs`, `bureau_catalog_items`) e a assinatura nova de `resolve_product_terms`.
- Se `with_ai` sai da tabela ou fica sempre `true`.
- Layout das telas de catálogo, do formulário do pedido e da lista de aceites.

## Afeta

Mapa do código atual (levantamento de 2026-10-24):

- Catálogo: `db/migrations/010_catalog.sql` (`products`, `product_versions`, `bureau_product_costs`, `bureau_catalog_items`, `resolve_product_terms`), `src/lib/catalog/queries.ts`, `src/lib/catalog/quote.ts`, `src/actions/catalog.ts`, telas em `src/app/(superadmin)/superadmin/products/`, `src/components/superadmin/{product-form,product-version-form,bureau-costs-panel}.tsx`, `src/app/(dashboard)/settings/catalog/page.tsx`, `src/components/settings/catalog-form.tsx`.
- Pedido: `db/migrations/022_orders_delivery.sql` (`dossier_orders` com CHECKs de `product_code`, `dossier_orders_full_counter` e `with_ai`; `open_order`, `reserve_order`, `refresh_order_state`), `src/lib/orders/`, `src/lib/settlement/queries.ts`, `src/lib/validators/order.ts`.
- Formulários: `src/components/dossiers/dossier-form.tsx` (balcão), `src/components/orders/client-order-form.tsx` e `src/app/(portal)/portal/pesquisas/` (portal), `src/actions/orders-client.ts`, `src/actions/orders.ts`.
- Testes que mudam: `src/lib/catalog/*.test.ts`, `src/lib/orders/*.integration.test.ts`, `src/lib/settlement/*.integration.test.ts`, `src/lib/validators/order.test.ts`, `src/components/settings/catalog-form.test.ts`, `src/components/superadmin/bureau-costs-panel.test.ts`, `src/lib/db/rls.integration.test.ts`, `src/test/seed.ts`, `e2e/fixtures.ts`.

Relacionado: item 18 da issue #72 (a consulta continua "Aguardando SCR" depois da autorização). A tela de aceites desta spec depende do estado por membro. Resolva o item 18 como primeira tarefa deste plano: na transação da autorização, a consulta autorizada sai de `pending_authorization`.

## Relação com a próxima spec (afiliados)

A próxima spec cria o programa de afiliados: link no perfil do cliente, % de comissão por afiliado definida pelo Bureau, comissão creditada numa carteira do afiliado, saque com taxa definida pelo superadmin (fixo, %, ou fixo + %), telas de afiliado, de saque e de afiliados do Bureau, e saldo visível ao entrar.

Para não bloquear essa spec, esta entrega deve:
- guardar no pedido o total de venda e o total de custo congelados (já existe em `order_settlements`), porque a comissão deve sair da margem (venda − custo) (hipótese a confirmar na spec de afiliados);
- não criar regra que impeça um segundo beneficiário da margem além do Bureau.

`PRODUCT.md` lista hoje "comissão" como fora de escopo. Atualize na spec de afiliados.

## Critérios de aceitação

- [ ] O catálogo do superadmin e do Bureau mostra só Dossiê Pessoa Física e Dossiê Empresarial Estruturado, com `valor_base` e `valor_por_socio` (este só no empresarial).
- [ ] Teste: Dossiê Empresarial com 0, 1 e 3 sócios reserva `base + n × por_sócio` na venda e no custo; sócio repetido conta uma vez.
- [ ] Teste: `reserve_order` recusa um total diferente do recalculado.
- [ ] Teste: o Bureau não salva venda abaixo do custo em nenhum dos dois campos.
- [ ] Teste: todo pedido concluído gera parecer IA, sem linha de adicional na cotação nem no extrato.
- [ ] Teste: no portal, o cliente abre um Dossiê Empresarial com sócios; o pedido só fica `ready` depois de todos autorizarem.
- [ ] Teste: o cliente cancela em `awaiting_authorization` e em `ready`; a reserva volta inteira; o cancelamento em `executing` é recusado; outro cliente não cancela o pedido.
- [ ] Teste: pedido com membros sem o checkbox de declaração é recusado no servidor; com o checkbox, o aceite fica gravado com a versão do texto.
- [ ] (post-deploy) O texto da declaração e a cláusula dos Termos de Uso foram revisados pelo advogado.
- [ ] Teste: conta PF não abre Dossiê Pessoa Física de terceiro; conta PJ abre Dossiê Pessoa Física só com o CPF do responsável.
- [ ] Teste: o banco e o zod recusam sócio com 14 dígitos.
- [ ] Teste: no portal, membro com o e-mail do comprador é aceito só quando o CPF do membro é o CPF da conta; com outro CPF, é recusado (`contact_is_buyer`); no balcão, continua recusado.
- [ ] Teste: depois da autorização SCR, a consulta sai de `pending_authorization` antes do tick (item 18 da #72).
- [ ] A página do pedido no portal mostra o estado da autorização de cada membro.
- [ ] Caso novo em `rls.integration.test.ts` para cada tabela ou coluna nova.
- [ ] `npm run check` verde e e2e de balcão e portal ajustados.
- [ ] (post-deploy) Um Dossiê Empresarial real com sócios conclui na DEPS e o valor bate com o extrato.
