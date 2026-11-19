# Cupons de desconto do Bureau — design

Data: 2026-11-19. Estado: aprovado pelo usuário em 2026-11-19.

## Objetivo

Cada Bureau cria cupons. O cliente digita o código antes de abrir uma pesquisa e paga menos, ou nada. Um cupom de 100% deixa o cliente rodar uma consulta sem saldo (demonstração).

Por que: hoje o cliente só roda uma consulta se tem saldo. O Bureau não tem como dar uma demonstração ou uma promoção.

## Metas

- O Bureau cria cupons de dois tipos: percentual e valor fixo.
- Um cupom vale para qualquer produto (trunfo) ou só para produtos escolhidos (`dossie_pf`, `dossie_empresarial`).
- Limites: usos totais (ou ilimitado), usos por cliente, data de início e de validade. Com limite total e sem limite por cliente informado, o limite por cliente é 1. Sem limite total, o padrão é ilimitado. O Bureau pode escolher "ilimitado" por cliente de forma explícita.
- O preço com desconto é decidido no banco. A tela só mostra uma prévia.
- O Bureau só dá um desconto que ele consegue cobrir (veja "Quem paga").

## Fora de escopo

- Balcão (staff abre a pesquisa). Só o portal do cliente usa cupom.
- Desconto na recarga de saldo.
- Mais de um cupom por pesquisa.
- Cupom criado pela plataforma ou pelo afiliado.
- Cupom que o cliente recebe sem digitar o código.

## Como o dinheiro anda hoje (fatos verificados nas migrações)

- No portal, a reserva usa a carteira do cliente (`client_wallets`) pelo **preço**. A carteira pré-paga do Bureau (`wallets`) **não** é usada (`reserve_order`, 022).
- Na captura (`capture_order`, 027), o Bureau recebe a margem `preço − custo` como acréscimo em `bureau_payable_entries` (menos a comissão de afiliado). O custo fica com a plataforma.
- `reserve_order` recusa `preço <= 0` (`invalid_amount`) e `preço < custo` (`price_below_cost`). `order_settlements` exige `price > 0` e `price >= cost`. `client_ledger_entries.amount` exige `> 0`.
- O saldo a repassar liberado vem de `payable_buckets` (047). Só os tipos `accrual` e `reversal` entram nele.

## Quem paga

O desconto reduz a margem do Bureau. Se o preço pago fica abaixo do custo, a plataforma perderia dinheiro. O Bureau cobre a diferença:

`falta = max(custo − preço pago, 0)`

- A falta sai primeiro da carteira pré-paga do Bureau (`wallets`). O banco reserva o valor na reserva do pedido, captura na captura e libera na liberação.
- O que a carteira não cobre sai do valor a repassar já **liberado** (bucket `released`), com um lançamento negativo.
- Se os dois juntos não cobrem a falta, o cupom é recusado (`coupon_funds_insufficient`). O pedido não abre.
- Se o preço pago é maior ou igual ao custo, a falta é zero. A margem é só menor.

## Abordagens consideradas

1. **Desconto gravado no pedido, calculado no SQL.** Escolhida. Cobre percentual, fixo, trunfo, produto específico e limites, sem abrir brecha.
2. Cupom vira crédito na carteira do cliente. Não atende percentual nem restrição por produto.
3. Desconto só no TypeScript. `reserve_order` recalcula o preço e recusa o valor. Uma validação só na tela é burlável.

## Modelo de dados (migração `048_coupons.sql`)

- `coupons`: `id`, `bureau_id`, `code` (6–32 caracteres para códigos novos, `A-Z0-9_-`; o banco aceita 3–32, então códigos antigos de 3–5 caracteres seguem válidos e usáveis; único por Bureau sem diferenciar maiúsculas), `kind` (`percent` | `fixed`), `value` (percentual de 0,01 a 100; fixo em reais, maior que 0), `all_products` boolean, `max_uses` (null = ilimitado), `max_uses_per_client` (null = ilimitado; padrão 1 quando `max_uses` existe e o campo não é informado), `valid_from`, `valid_until` (null = sem fim), `active`, `created_by`, `created_at`.
- `coupon_products`: `coupon_id`, `product_id`. Só tem linhas se `all_products` é falso.
- `coupon_redemptions`: `id`, `coupon_id`, `bureau_id`, `client_profile_id`, `order_ref` (único), `discount`, `funded_wallet`, `funded_payable`, `status` (`reserved` | `consumed` | `released`), `created_at`, `closed_at`. Só a transição `reserved` → `consumed` ou `released` é permitida (mesmo padrão de `order_settlements_guard`). Um uso conta enquanto está `reserved` ou `consumed`.
- `order_settlements`: novas colunas `coupon_id` e `discount`. Os checks passam a `price >= 0` e, só quando `coupon_id` existe, a dispensa de `price >= cost`. Sem cupom, as regras atuais ficam iguais.
- `bureau_payable_entries`: novos tipos `coupon_cost` (negativo) e `coupon_refund` (positivo), sempre com `order_ref`. `payable_buckets` e `create_payout` passam a contá-los, e o lançamento negativo nunca pode deixar o saldo `released` abaixo de zero.
- Todas as tabelas novas: RLS com `enable` e `force`, política de escrita só para o admin do Bureau, e caso novo em `src/lib/db/rls.integration.test.ts`. O cliente não lê `coupons`. Ele usa o cupom só pela função do banco.

## Regras de desconto

- A base do desconto é o total das linhas dos produtos que o cupom aceita. Um pedido com um produto que o cupom não aceita não recebe desconto nessa linha. Se nenhuma linha é aceita, o resultado é `coupon_product_not_allowed`.
- Percentual: `round(base × valor / 100, 2)`. Fixo: `min(valor, base)`. O preço pago nunca é negativo.
- Preço pago `0`: o pedido abre sem reserva na carteira do cliente, e a captura e a liberação do cliente são puladas.
- Cupom válido exige: `active`, dentro de `valid_from`/`valid_until`, usos totais e usos do cliente abaixo do limite. A função trava a linha do cupom (`for update`) para dois pedidos simultâneos não passarem do limite.
- Uso devolvido: se o pedido é liberado ou cancelado (`release_order`), a redenção vira `released`, a carteira do Bureau é liberada e o lançamento `coupon_refund` devolve o que saiu do valor a repassar.
- Comissão de afiliado: continua `margem = pago − custo` e só vale se a margem é maior que zero.

## Contrato

- `reserve_order` recebe `p_coupon_code text` (null = sem cupom). Recalcula o preço de tabela, aplica o cupom e compara com `p_price` (o preço pago). `price_mismatch` continua valendo. Motivos novos: `coupon_invalid`, `coupon_expired`, `coupon_exhausted`, `coupon_client_limit`, `coupon_product_not_allowed`, `coupon_funds_insufficient`.
- `capture_order` marca a redenção como `consumed` e captura da carteira do Bureau o valor reservado.
- Server Actions (zod, depois sessão e `hasPermission`, depois consulta, depois `revalidatePath`, retorno `{ error, id? }`):
  - `createCouponAction`, `updateCouponAction`, `setCouponActiveAction` (permissão `coupons:write`, admin do Bureau).
  - `previewCouponAction` (cliente): devolve o preço com desconto sem consumir nada. Para código desconhecido, vencido, de outro Bureau ou fora do escopo, a mensagem é a mesma: "Cupom inválido ou indisponível".
- Auditoria na mesma transação: `coupon.create`, `coupon.update`, `coupon.deactivate`, `coupon.redeem`, `coupon.release`. Rótulos em `src/lib/audit/labels.ts`. Nenhum CPF/CNPJ completo na auditoria.
- O código do cupom não vai para log de erro junto com dado do cliente.

## Interface (pt-BR)

- `settings/cupons`: lista (código, tipo e valor, produtos, usos/limite, validade, ativo), criar, editar e desativar. Segue `settings/catalog`. Link no menu de configurações do admin.
- `portal/pesquisas/nova`: campo "Cupom" com botão "Aplicar". Mostra preço de tabela, desconto e total. O valor enviado ao abrir a pesquisa é o da prévia, e o banco confirma.

## Testes

- Integração (Postgres real): percentual, fixo, 100% sem saldo, trunfo e produto específico, limite total, limite por cliente, validade, duas redenções simultâneas no último uso, falta coberta pela carteira, pela carteira mais o repasse, e recusa sem fundos, liberação devolve uso e valores, afiliado com margem zero.
- RLS: um Bureau não lê nem usa o cupom de outro; o cliente não lê `coupons`.
- Unidade: cálculo de desconto em centavos (arredondamento).

## Nota fiscal (decisão do usuário)

Pedido com preço pago 0 **não emite NFS-e** (decisão do usuário). Verificado no código (T5): a NFS-e só é disparada por pagamento confirmado de recarga em `pix_charges` (`src/lib/nfse/invoice.ts`). Um pedido gasta saldo já creditado e nunca cria nota. Por isso nenhum pedido com cupom emite nota, e nenhuma guarda é necessária. Se o Bureau quiser nota por consumo, é uma funcionalidade fiscal nova, fora deste escopo (veja o aviso D3 em `docs/operations/nfse.md`).

## Decisões minhas (confira)

- Código sem diferenciar maiúsculas e minúsculas, guardado em maiúsculas.
- Só o valor a repassar **liberado** cobre a falta, nunca o retido. Motivo: o retido ainda pode ser estornado.
- Falha de pedido devolve o uso do cupom.
- Mensagem única para cupom inválido, para não permitir adivinhar códigos. Limite de tentativas: o construtor reaproveita o limitador de taxa que o projeto já tem, se existir.
- Permissões novas `coupons:read` e `coupons:write`, só para o admin do Bureau.
- Reembolso depois da captura (PIX ou cartão, ajuste de saldo): devolve só o que o cliente pagou. O `coupon_cost`, a captura da carteira do Bureau e a redenção `consumed` **não** são desfeitos. Motivo: o desconto já foi dado e o uso do cupom foi gasto. Um pedido com preço pago 0 não tem nada a reembolsar.
- `coupon_cost` é lançado na **reserva**, não na captura. Ele vale na hora (como `reversal`), sem prazo de retenção, e entra na conta do repasse. A reserva de pedido com cupom toma o mesmo advisory lock `payout:<bureau>` que `create_payout` usa, para um repasse e um cupom não gastarem o mesmo dinheiro. O saldo `released` nunca fica abaixo de zero no momento do lançamento. `debt` continua existindo só para os estornos que já existem.
- Pedido com preço pago menor que o custo: a captura não cria acréscimo nem comissão (margem menor ou igual a zero). Não existe acréscimo negativo. A divisão `funded_wallet`/`funded_payable` é fixada na reserva, e uma falha na captura desfaz a transação inteira.
- Carteira do Bureau: reaproveita os tipos `reserve`, `capture` e `release` de `wallet_post_entry`, com chave de idempotência `coupon:<order_ref>:<passo>`.
- Todo caminho que fecha um pedido sem passar por `release_order` (expiração, cancelamento, o tick de pedidos) deve devolver a redenção e os valores. O construtor lista esses caminhos e cobre cada um com teste.
- O desconto é arredondado **uma vez**, sobre a soma das linhas aceitas (não por linha). `price_mismatch` compara o preço de tabela menos esse desconto.

## Pós-deploy

Nenhum item.
