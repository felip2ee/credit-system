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

- Variáveis de deploy (não secretas): `WHATSAPP_DRIVER=meta`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION`. O padrão `WHATSAPP_DRIVER=fake` deixa o WhatsApp desligado.
- Docker secrets: `whatsapp_access_token`, `whatsapp_app_secret`, `whatsapp_verify_token`, `notifications_dispatch_secret`.
- O `setup_production.py` gera os dois últimos. Se você deixar vazios o token e o app secret, ele grava o marcador `whatsapp-disabled` (o Swarm não aceita secret vazio).
- Um secret do Swarm é imutável. Para trocar o valor: remova o serviço que o usa, `docker secret rm`, recrie o secret e faça o deploy de novo.

## 4. Aprovar e registrar um template

1. Em **WhatsApp > Modelos de mensagem**, crie o template na categoria **Utility** (transacional).
2. Aguarde a aprovação da Meta.
3. Registre o template por migration (`db/migrations/NNN_*.sql`) com:
   - **nome** (idêntico ao da Meta);
   - **idioma** (ex.: `pt_BR`);
   - **ordem dos parâmetros** (`{{1}}`, `{{2}}`, ...).
4. Nunca edite uma migration aplicada. Para mudar o template, crie uma nova versão.
5. Nunca use CPF/CNPJ como parâmetro.

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
