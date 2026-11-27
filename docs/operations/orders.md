# Pedidos de pesquisa (M6)

Um pedido liga a pesquisa ao pagamento, à autorização SCR e à entrega. Cada Dossiê tem um pedido, em `dossier_orders`. O estado do pedido é protegido por trigger: só as transições da tabela abaixo são aceitas.

Spec: [docs/superpowers/specs/2026-10-15-m6-pesquisa-e-entrega-design.md](../superpowers/specs/2026-10-15-m6-pesquisa-e-entrega-design.md).

## 1. Estados

| Estado | Significado | Sai para |
|---|---|---|
| `awaiting_payment` | balcão sem pagamento completo | `awaiting_authorization`, `ready`, `cancelled` |
| `awaiting_authorization` | falta autorização utilizável de algum membro | `ready`, `awaiting_payment`, `cancelled` |
| `ready` | pago e autorizado; na fila do tick | `executing`, `awaiting_authorization`, `awaiting_payment`, `cancelled` |
| `executing` | lease ativa; DEPS em curso | `executing` (lease vencida), `ready` (transitório), `completed`, `failed` |
| `completed` | capturado; aguarda parecer IA e/ou liberação | `released` |
| `released` | entrega visível ao comprador | `completed` (revogação) |
| `failed` | falha terminal; reserva liberada | — |
| `cancelled` | recusa, expiração, prazo de pagamento ou cancelamento da equipe ou do cliente; reserva liberada | — |

### Fluxo do pedido no portal

1. O cliente escolhe o dossiê, informa os dados e (se houver membros) marca a declaração do comprador. O valor total é reservado da carteira.
2. Cada membro (responsável da empresa e sócios) recebe o pedido de autorização SCR. Quando um membro autoriza, a consulta dele passa a `processing` na hora.
3. Quando todos autorizam, o pedido fica `ready` e o próximo tick o executa.

### Estado do aceite por membro

A página do pedido lista cada membro com o estado: pendente, autorizado, recusado ou vencido. Se um membro recusa ou deixa vencer, o pedido não roda e a página mostra o aviso.

### Correção do contato pela equipe

- `updateOrderContactAction` troca o e-mail e/ou o celular de um membro, ou só reenvia ao mesmo contato. Vale em `awaiting_payment` e `awaiting_authorization`, com a autorização do membro ainda `pending` e dentro do prazo. Outro estado devolve `invalid_state`.
- O link enviado antes deixa de valer na hora: o token muda, o código é apagado e o aviso ainda na fila é anulado. Quem recebeu o e-mail errado não autoriza mais.
- Em `awaiting_authorization` o aviso novo sai logo em seguida. Se o envio falhar, o contato já está salvo e o tick envia na próxima rodada (cerca de 1 minuto): o tick reemite toda autorização pendente sem código.
- Em `awaiting_payment` a troca só grava o contato e gira o token. Nada é enviado: a autorização sai depois do pagamento, quando o pedido passa a `awaiting_authorization`. A tela mostra "Contato atualizado. A autorização sai depois do pagamento." "Reenviar" sem mudança nesse estado devolve `invalid_state`, e o botão fica oculto.
- A emissão só grava se a autorização ainda tem o token lido (`superseded` caso contrário, sem erro): duas trocas quase juntas, ou um tick que leu o contato antes da troca, não trazem o e-mail antigo de volta. Vale o último contato trocado.
- Contato digitado não pode ser o do comprador (`contact_is_buyer`), exceto quando o membro é um Titular do comprador: aí o servidor usa o e-mail da conta e descarta o digitado. A recusa fica na trilha (`order.update_contact_refused`), sem o contato.
- Limites: 3 pedidos novos por destinatário em 24 h (`too_many_requests`), 2 minutos desde a última troca ou reenvio da mesma autorização (`resend_too_soon`, vale também sem envio feito) e 5 trocas ou reenvios por autorização em 24 h (`contact_limit_reached`).
- A autorização é compartilhada entre pedidos do mesmo comprador e Titular (D10): a troca vale para todos. Cada pedido que ainda espera pagamento ou autorização recebe o seu evento `order.update_contact`; pedidos já autorizados ou concluídos ficam de fora.
- A auditoria `order.update_contact` é gravada na própria função, na mesma transação, com ids, `previous_email_masked`, `email_masked`, `resend_only` e `buyer_override`. Nunca guarda o e-mail completo.
- Risco residual conhecido: a regra D12 compara o e-mail sem normalizar `+tag` nem pontos (`a+x@dominio` e `a.b@gmail.com` passam como e-mails diferentes do comprador). A limitação já existia na abertura do pedido e não foi tratada aqui.

### Correção do e-mail pelo cliente (068)

- O cliente corrige o e-mail de um membro do próprio pedido, ou só reenvia o pedido de autorização, pela seção "Autorizações" da página do pedido. A função `update_my_order_member_email` vale em `awaiting_payment` (só corrigir) e `awaiting_authorization`, com a autorização `pending` e dentro do prazo. A posse do pedido é conferida em SQL: pedido de outro cliente, de outro Bureau ou sessão da equipe devolve `not_found`.
- `authorized`, `refused` e `expired` não editam. Trocar o e-mail depois da resposta apagaria uma prova de consentimento, e o tick cancela o pedido vencido (`scr_expired`), então editar não o revive.
- A troca gira o token, apaga o código, renova o prazo (7 dias, só em `awaiting_authorization`) e anula o e-mail ainda na fila. A função não envia: o tick emite o link novo, cerca de 20 s depois, porque a autorização fica `pending` sem código. O cliente não tem política de escrita em `scr_authorizations`, e `issueSelfScrAuthorization` precisa dela.
- Limite: 3 trocas ou reenvios por autorização em 24 h (`client_member_change_limit()`), com 2 minutos entre um e outro. Os instantes ficam em `contact_changes_at`, o mesmo contador da equipe (limite 5): os dois lados somam. Motivos: `resend_too_soon`, `resend_limit_reached`.
- Recusas sem gastar limite: `same_email` (e-mail igual ao atual, sem diferença de caixa), `contact_is_buyer`, `own_account_email` (o membro é um Titular do comprador: só reenviar). Teto de 3 autorizações `pending` em 24 h por destinatário: `too_many_requests`.
- `client_order_members` devolve o id da consulta, o e-mail mascarado e as flags `can_edit_email`, `can_resend` e `changes_left`. A interface só lê as flags; o servidor decide de novo a cada ação.
- Auditoria na mesma transação: `order.member_email_update` e `order.member_resend`, com e-mail mascarado e `shared_dossiers`. Nunca guarda o e-mail completo nem o documento.
- Tetos contra abuso (069): no máximo 10 ações por cliente em 24 h (trocas, reenvios e tentativas recusadas, `client_member_daily_cap()`), 3 pedidos pendentes por celular de terceiro, e a recusa por `resend_too_soon` ou `too_many_requests` grava `order.member_email_attempt` (só ids e motivo) sem gastar o limite da autorização. Acima do teto o motivo é `too_many_requests`.

### Cancelamento pelo cliente

- O cliente cancela o próprio pedido em `awaiting_authorization` ou `ready`, com o botão "Cancelar pedido".
- O pedido vai para `cancelled` (`cancelled_by_client`), a reserva volta ao saldo e a auditoria registra o evento na mesma transação.
- Depois de `executing`, o cliente não cancela.

## 2. Prazos

- Pedido de autorização SCR: expira 7 dias depois da criação do pedido. O envio do código renova o prazo.
- Pedido de autorização SCR sem e-mail para reenviar (autorização vencida): a autorização passa a `expired` e o pedido vai para `cancelled` (`scr_expired`).
- Pedido de balcão: sem pagamento completo em 7 dias, o pedido vai para `cancelled` (`payment_timeout`) e libera o custo reservado.
- Execução: 5 tentativas no máximo. Cada claim cria uma lease de 5 minutos. Lease vencida volta a executar. Claim com mais de 5 tentativas vai para `failed` (`deps_unavailable`) sem chamar a DEPS.
- Chamada à DEPS: aborta em 120 s e conta como erro transitório.
- Erro transitório da DEPS: o pedido volta para `ready` com espera de `2^(tentativa-1)` minutos, no máximo 60. Na 5ª falha, o pedido vai para `failed` e libera a reserva.
- Parecer IA: 3 tentativas. A tentativa é contada antes da chamada ao modelo, com lease de 5 minutos. Depois, `ai_status = failed`. A entrega sai sem parecer.
- Pedidos de autorização por destinatário: no máximo 3 pedidos pendentes por e-mail ou celular em 24 h por Bureau. O 4º pedido é recusado (`too_many_requests`).
- Pedidos online por cliente: no máximo 5 em 24 h. O 6º é recusado (`too_many_orders`). Ao cancelar um pedido, os links de autorização pendentes dele passam a `expired`.

## 3. Cron

- O serviço `notifications_cron` chama `ORDERS_TICK_URL` a cada 10 s (`NOTIFICATIONS_CRON_INTERVAL_MS`), depois do despacho de notificações, quando a variável existe. Um segundo despacho roda logo após o tick. O SMTP e o lease de 2 minutos em falha não mudam.
- A chamada usa o mesmo segredo do despacho: `Authorization: Bearer $NOTIFICATIONS_DISPATCH_SECRET`.

## 4. Rodar o tick à mão

```bash
curl -X POST \
  -H "Authorization: Bearer $NOTIFICATIONS_DISPATCH_SECRET" \
  "$ORDERS_TICK_URL"
```

Um Bureau é processado por um tick de cada vez (lock de sessão no banco). Se outro tick já processa o Bureau, o tick novo o pula e conta em `skipped` na resposta. A lease impede que a DEPS seja chamada duas vezes para o mesmo pedido.

## 5. Ver um pedido preso

Rode no banco, com `DATABASE_OWNER_URL`:

```sql
select dossier_id, state, attempts, lease_until, next_attempt_at
  from dossier_orders
 where state in ('executing', 'ready');
```

- `executing` com `lease_until` no passado: a lease venceu. O próximo tick executa o pedido de novo.
- `ready` com `next_attempt_at` no futuro: o pedido espera a retentativa.
- `attempts` igual a 5 e o pedido ainda não está `failed`: verifique os logs do tick antes de agir.

## 6. Pedidos com cupom

Regras do cupom: [spec de cupons](../superpowers/specs/2026-11-19-cupons-desconto-design.md). Fluxo do dinheiro: [architecture.md](architecture.md#cupons).

- Liberação, cancelamento (equipe, cliente ou expiração) e falha passam por `release_order`. Em todos, a redenção vira `released` e o uso volta ao cupom (conta para o limite total e por cliente).
- Os mesmos caminhos liberam a reserva na carteira do Bureau e lançam `coupon_refund`. Esse lançamento devolve ao repasse o valor que o cupom tirou dele.
- Pedido com preço pago 0 não tem reserva na carteira do cliente. Não há nada a liberar desse lado.
- Depois da captura, o pedido não é liberado. Um estorno de pagamento devolve só o que o cliente pagou.
- Depois da captura, `coupon_cost`, a captura da carteira do Bureau e a redenção `consumed` não são desfeitos. O cupom fica gasto.
- Para ver o estado de um uso, consulte `coupon_redemptions`: `reserved`, `consumed` ou `released`.
