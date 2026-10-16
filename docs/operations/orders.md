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
| `cancelled` | recusa, expiração, prazo de pagamento ou cancelamento da equipe; reserva liberada | — |

## 2. Prazos

- Pedido de autorização SCR: expira 7 dias depois da criação do pedido. O envio do código renova o prazo.
- Pedido de autorização SCR sem e-mail para reenviar (autorização vencida): a autorização passa a `expired` e o pedido vai para `cancelled` (`scr_expired`).
- Pedido de balcão: sem pagamento completo em 7 dias, o pedido vai para `cancelled` (`payment_timeout`) e libera o custo reservado.
- Execução: 5 tentativas no máximo. Cada claim cria uma lease de 5 minutos. Lease vencida volta a executar. Claim com mais de 5 tentativas vai para `failed` (`deps_unavailable`) sem chamar a DEPS.
- Chamada à DEPS: aborta em 120 s e conta como erro transitório.
- Erro transitório da DEPS: o pedido volta para `ready` com espera de `2^(tentativa-1)` minutos, no máximo 60. Na 5ª falha, o pedido vai para `failed` e libera a reserva.
- Parecer IA: 3 tentativas. A tentativa é contada antes da chamada ao modelo, com lease de 5 minutos. Depois, `ai_status = failed`. A entrega sai sem parecer.
- Pedidos de autorização por destinatário: no máximo 3 pedidos pendentes por e-mail ou celular em 24 h por Bureau. O 4º pedido é recusado (`too_many_requests`).

## 3. Cron

- O serviço `notifications_cron` chama `ORDERS_TICK_URL` a cada 60 s, depois do despacho de notificações, quando a variável existe.
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
