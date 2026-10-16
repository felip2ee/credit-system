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

- Pedido de autorização SCR: expira 7 dias depois do envio.
- Pedido de balcão: sem pagamento completo em 7 dias, o pedido vai para `cancelled` (`payment_timeout`) e libera o custo reservado.
- Execução: 5 tentativas no máximo. Cada claim cria uma lease de 5 minutos. Lease vencida volta a executar.
- Erro transitório da DEPS: o pedido volta para `ready` com espera de `2^(tentativa-1)` minutos, no máximo 60. Na 5ª falha, o pedido vai para `failed` e libera a reserva.
- Parecer IA: 3 tentativas. Depois, `ai_status = failed`. A entrega sai sem parecer.

## 3. Cron

- O serviço `notifications_cron` chama `ORDERS_TICK_URL` a cada 60 s, depois do despacho de notificações, quando a variável existe.
- A chamada usa o mesmo segredo do despacho: `Authorization: Bearer $NOTIFICATIONS_DISPATCH_SECRET`.

## 4. Rodar o tick à mão

```bash
curl -X POST \
  -H "Authorization: Bearer $NOTIFICATIONS_DISPATCH_SECRET" \
  "$ORDERS_TICK_URL"
```

Duas chamadas em paralelo não chamam a DEPS duas vezes para o mesmo pedido. A lease impede isso.

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
