# Monitoramento e alertas

O projeto não usa Sentry nem Prometheus (decisão D3 do [spec do M7](../superpowers/specs/2026-10-16-m7-producao-design.md)). Três mecanismos cobrem a operação:

| Mecanismo | Verifica | Quem age |
|---|---|---|
| Healthcheck do Swarm | `GET /api/health/live` no `reino_app`. Se falhar, o Swarm reinicia o app. | Automático |
| Cron de alertas | Despacho de notificações, tick de pedidos, erros e backup atrasado. Envia e-mail para `OPS_ALERT_TO`. | Operador |
| Monitor externo | `GET https://<APP_DOMAIN>/api/health/ready`, de fora do servidor. | Operador (configuração pós-deploy) |

O healthcheck usa `/live`. Queda do banco não deve reiniciar o app. O monitor externo usa `/ready`, que testa o banco e o disco de documentos.

## 1. Alertas por e-mail

O serviço `notifications_cron` roda `scripts/notifications-cron.mjs` a cada 60 s. Ele chama o despacho de notificações e o tick de pedidos. Também confere o marcador de backup.

| Chave | Assunto | Dispara quando | Primeiro passo |
|---|---|---|---|
| `dispatch_down` | `[reino] dispatch indisponível` | 5 respostas seguidas não-200, ou falha de rede, em `POST /api/internal/notifications/dispatch` | `docker service logs reino_app`, depois `docker service ps reino_app` |
| `tick_down` | `[reino] tick indisponível` | 5 respostas seguidas não-200, ou falha de rede, em `POST /api/internal/orders/tick` | Igual ao anterior |
| `dispatch_failed` | `[reino] notificações falhando` | Resposta do despacho com `failed > 0` ou `errors > 0` | Logs com `[notifications-dispatch]`. Estados de falha em [notifications.md](notifications.md), seção 6 |
| `tick_errors` | `[reino] tick com erros` | Resposta do tick com `errors > 0` | Logs com `[orders-tick]`. Veja [orders.md](orders.md) |
| `backup_stale` | `[reino] backup atrasado` | Marcador `/var/lib/backup/last-success` com mais de 36 h | `docker service logs reino_backup`. Rode o backup manual do [deploy.md](deploy.md) |

Regras de envio:

- Cada chave envia no máximo um e-mail a cada 60 min.
- Se o envio falha, a janela não é gravada. O cron tenta de novo no próximo ciclo. Com o SMTP fora do ar, isso gera uma linha de log por minuto.
- Não há e-mail de recuperação. Quando a condição passa, nada é enviado.
- Sem `OPS_ALERT_TO`, o cron só grava no log.
- O corpo do e-mail traz a chave, o status HTTP, as contagens e o horário. Não traz segredo nem dado pessoal.
- Os alertas usam o mesmo SMTP do app. Se o SMTP cair, nenhum alerta sai. Por isso o monitor externo é a redundância (seção 3).

Log do cron: `docker service logs reino_notifications_cron`. As linhas começam com `notifications-cron:`.

## 2. Erros nos logs

O projeto não tem agregação de erros. Os `console.error` começam com um prefixo entre colchetes. Para listar os erros do app:

```sh
docker service logs --raw reino_app 2>&1 | grep -E '^\[|error'
```

Prefixos em uso: `[auth]`, `[account]`, `[asaas-webhook]`, `[whatsapp-webhook]`, `[orders]`, `[orders-tick]`, `[orders-execute]`, `[orders-ai]`, `[notifications]`, `[notifications-dispatch]`, `[wallet]`, `[payouts]`, `[payout-receipt]`, `[payables]`, `[credits]`, `[counter-payments]`, `[nfse]`, `[catalog]`, `[lgpd]`.

Os logs do Docker usam `json-file` com 10 MB por arquivo e 3 arquivos por serviço. Linhas antigas somem sozinhas. Para guardar um histórico, exporte o log antes do rodízio.

## 3. Monitor externo de uptime (post-deploy)

Configure um monitor de fora do servidor (UptimeRobot, Better Stack ou similar):

1. Tipo: HTTP(s).
2. URL: `https://<APP_DOMAIN>/api/health/ready`.
3. Intervalo: de 1 a 5 min.
4. Alerta: e-mail do operador de plantão.

Os dois endpoints de saúde são públicos. Não exigem sessão. `/ready` falha se o banco ou o disco de documentos falhar.

## 4. Resposta a alerta

1. Confirme o estado: `docker service ps <serviço>`.
2. Leia os logs do serviço com o prefixo da chave (tabela da seção 1).
3. Corrija a causa. Para o backup, rode o backup manual.
4. Não reinicie a stack inteira para resolver um alerta de um serviço só. Use `docker service update --force <serviço>`.

Se o alerta chegar sem uma causa clara, abra um ticket com a chave, o horário e o trecho do log. Não cole o corpo de requisição nem segredos.
