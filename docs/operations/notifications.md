# Notificações (e-mail e WhatsApp)

O M4 envia e-mail e WhatsApp por uma fila no Postgres (outbox). O serviço `notifications_cron` chama a rota de despacho a cada 60 s.

## 1. Criar o app e o número na Meta

1. Abra o Meta for Developers e crie um app do tipo **Business**.
2. Adicione o produto **WhatsApp**.
3. Vincule uma conta WhatsApp Business (WABA) e registre o número da plataforma.
4. Anote o **Phone number ID**. Ele vira `WHATSAPP_PHONE_NUMBER_ID`.
5. No Business Manager, crie um **usuário de sistema** com permissão `whatsapp_business_messaging` e `whatsapp_business_management` sobre a WABA.
6. Gere o token do usuário de sistema, sem expiração. Ele vira o secret `whatsapp_access_token`.
7. Em **Configurações do app > Básico**, copie o **App secret**. Ele vira o secret `whatsapp_app_secret`.

## 2. Cadastrar o webhook

1. Em **WhatsApp > Configuração**, clique em editar o webhook.
2. URL de callback: `https://<APP_DOMAIN>/api/webhooks/whatsapp`.
3. Verify token: o valor do secret `whatsapp_verify_token` (veja em `credenciais-GUARDAR.txt`).
4. Assine o campo **`messages`**. Ele entrega os status de envio e as respostas (opt-out).

## 3. Configurar o deploy

- Variáveis de deploy (não secretas): `WHATSAPP_DRIVER=meta`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION`. Em produção, `WHATSAPP_DRIVER` vazio (o padrão), `WHATSAPP_DRIVER=fake` ou `WHATSAPP_PHONE_NUMBER_ID` vazio deixam o WhatsApp desligado: o envio falha como `channel_not_configured` (permanente) e o webhook responde 404. Um valor inválido com o driver ligado responde 500. O driver `fake` só vale fora de produção.
- Docker secrets: `whatsapp_access_token`, `whatsapp_app_secret`, `whatsapp_verify_token`, `notifications_dispatch_secret`, `app_dispatch_password`, `dispatch_database_url`.
- O `setup_production.py` gera `whatsapp_verify_token`, `notifications_dispatch_secret`, `app_dispatch_password` e `dispatch_database_url`. Se você deixar vazios o token e o app secret, ele grava o marcador `whatsapp-disabled` (o Swarm não aceita secret vazio).
- Um secret do Swarm é imutável. Para trocar o valor: remova o serviço que o usa, `docker secret rm`, recrie o secret e faça o deploy de novo.

### Roles do banco

| Role | Variável | Permissão (migration 020) |
|---|---|---|
| `app_webhook` | `DATABASE_WEBHOOK_URL` | Webhook do Asaas e do WhatsApp: `apply_asaas_payment`, `apply_whatsapp_status`, `record_notification_opt_out`. |
| `app_dispatch` | `DISPATCH_DATABASE_URL` (secret `dispatch_database_url`, arquivo em `DISPATCH_DATABASE_URL_FILE`) | Só a rota de despacho: `claim_notifications`, `complete_notification`. |

- A migration 020 cria `app_dispatch` sem senha. O script `docker/postgres/init/001-users.sh` define a senha só em volume novo.
- Em produção com volume existente, defina a senha uma vez, com o `app_dispatch_password` já criado como secret. Conecte com `DATABASE_OWNER_URL` e rode `ALTER ROLE app_dispatch PASSWORD '<valor>'`.
- Em dev, o volume novo do `docker-compose.dev.yml` já usa a senha `test`. Em volume antigo, rode `ALTER ROLE app_dispatch PASSWORD 'test'`.
- Os testes de integração leem `TEST_DATABASE_DISPATCH_URL` (o CI já define).

## 4. Aprovar e registrar um template

1. Em **WhatsApp > Modelos de mensagem**, crie o template na categoria **Utility** (transacional).
2. Aguarde a aprovação da Meta.
3. Registre o template por migration (`db/migrations/NNN_*.sql`) com:
   - **nome** (idêntico ao da Meta);
   - **idioma** (ex.: `pt_BR`);
   - **ordem dos parâmetros** (`{{1}}`, `{{2}}`, ...).
4. Nunca edite uma migration aplicada. Para mudar o template, crie uma nova versão.
5. Nunca use CPF/CNPJ como parâmetro.

**Template de autenticação (M5):** `verification_code`, categoria **Authentication**, idioma `pt_BR`, com botão **copiar código**. A migration 021 registra o template como `phone_verification`, com o parâmetro `code`. (post-deploy) A Meta aprova o template e um código real chega ao WhatsApp.

**Fora do escopo:** template de **marketing**. O M4 envia só mensagens transacionais pedidas pelo próprio fluxo.

## 5. Rodar o worker em dev

Suba o app (`npm run dev`) e chame a rota:

```bash
curl -X POST \
  -H "Authorization: Bearer $NOTIFICATIONS_DISPATCH_SECRET" \
  "$NOTIFICATIONS_DISPATCH_URL"
```

Para repetir a cada 60 s, rode o cron: `node scripts/notifications-cron.mjs` (com `NOTIFICATIONS_DISPATCH_URL` e `NOTIFICATIONS_DISPATCH_SECRET` no ambiente).

O `.env.example` traz os valores de dev (`WHATSAPP_DRIVER=fake`).

## 6. Estados, retentativa e retenção

- Estados: `pending` → `sending` → `sent` → `delivered` → `read`; ou `failed`; ou `suppressed`. O status da Meta só avança.
- Erro transitório (timeout, rede, 4xx do SMTP, 429 e 5xx da Meta): volta para `pending` com espera `2^(tentativa-1)` minutos, no máximo 60. São até 8 tentativas (cerca de 2 h).
- Erro permanente (5xx do SMTP, template ausente ou pausado, número sem WhatsApp, erro de render): vai direto para `failed`.
- Lease vencida (o processo caiu): volta para a fila e conta como tentativa.
- Retenção: destinatário e parâmetros são apagados em `sent`, `suppressed` e na resposta da Meta. Em `failed`, são apagados após **7 dias**. Ficam o destinatário mascarado e o hash.

## 7. Opt-out

- Quem responde `PARAR`, `SAIR`, `STOP`, `CANCELAR` ou `DESCADASTRAR` no WhatsApp entra em opt-out. As notificações para ele ficam `suppressed`.
- O M4 não tem comando para reverter. Só o **dono do banco** remove o opt-out, por SQL. Remova as duas formas do celular brasileiro (com e sem o nono dígito). Use o nome real da tabela e das colunas da migration `020_notifications.sql`; o exemplo abaixo é um modelo:

```sql
-- conecte com DATABASE_OWNER_URL
DELETE FROM notification_opt_outs
 WHERE recipient_hash IN (<hash da forma com 9>, <hash da forma sem 9>);
```

Confirme o nome da tabela e da coluna na migration antes de rodar. Registre o motivo no ticket.

## 8. Verificação pós-deploy

- `docker service logs reino_notifications_cron` mostra `status=200` a cada minuto.
- Um e-mail SCR real chega.
- Um WhatsApp de teste chega e o status `delivered` volta pelo webhook.
