# Notificações (e-mail, WhatsApp e push)

O M4 envia e-mail, WhatsApp e push por uma fila no Postgres (outbox). O serviço `notifications_cron` chama a rota de despacho a cada 10 s (`NOTIFICATIONS_CRON_INTERVAL_MS`, mínimo 5 s, padrão 60 s). Cada volta faz despacho, tick de pedidos e despacho de novo: o que o tick enfileira (como o aviso "resultado pronto") sai na mesma volta.

Limites conhecidos: a latência do SMTP e o lease de 2 minutos com backoff em caso de falha não mudam. Um envio que falha espera esse prazo antes de tentar de novo.

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

**Templates do M6 (migration 022):** `scr_authorization` (WhatsApp v1, `pt_BR`, parâmetros `clientName`, `authorizedName`, `code`, `url`) e `research_released` (e-mail v1 e WhatsApp v1, parâmetros `clientName`, `url`). (post-deploy) A Meta aprova `scr_authorization` e `research_released` no WhatsApp (`pt_BR`, categoria Utility). O aviso de liberação e o pedido de autorização usam esses nomes. Veja [orders.md](orders.md).

**Template da migration 084:** `affiliate_payout_changed` (só e-mail v1, parâmetros `clientName`, `actor`, `method`, `wallet`). Um trigger enfileira o aviso na mesma transação quando o modo de recebimento ou o walletId do afiliado muda. O walletId vai mascarado (4 últimos). A anonimização LGPD não avisa.

**Fora do escopo:** template de **marketing**. O M4 envia só mensagens transacionais pedidas pelo próprio fluxo.

## 5. Rodar o worker em dev

Suba o app (`npm run dev`) e chame a rota:

```bash
curl -X POST \
  -H "Authorization: Bearer $NOTIFICATIONS_DISPATCH_SECRET" \
  "$NOTIFICATIONS_DISPATCH_URL"
```

Para repetir a cada `NOTIFICATIONS_CRON_INTERVAL_MS` (padrão 60 s), rode o cron: `node scripts/notifications-cron.mjs` (com `NOTIFICATIONS_DISPATCH_URL` e `NOTIFICATIONS_DISPATCH_SECRET` no ambiente).

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

## 9. Push no aparelho

O canal `push` avisa o cliente do portal no celular ou no computador (Web Push). O worker usa a biblioteca `web-push` e as chaves VAPID.

1. Gere o par de chaves uma vez: `npx web-push generate-vapid-keys`.
2. Defina as 3 variáveis no deploy. O arquivo é `docker-stack.yml`, serviço `reino_app`:
   - `WEB_PUSH_VAPID_PUBLIC_KEY` (base64url, 87 caracteres; variável do `.env.production`);
   - `WEB_PUSH_VAPID_PRIVATE_KEY` (base64url, 43 caracteres; é secreta): Docker secret `web_push_vapid_private_key`, montado em `WEB_PUSH_VAPID_PRIVATE_KEY_FILE`. Crie com `printf %s "<chave-privada>" | docker secret create web_push_vapid_private_key -`;
   - `WEB_PUSH_VAPID_SUBJECT` (`mailto:` ou `https://` de contato; variável do `.env.production`).
3. Com a chave pública e o contato vazios, o push fica desligado (o secret da chave privada guarda o marcador `push-disabled`, porque o Swarm não aceita secret vazio): o envio falha como `channel_not_configured` (permanente). Config pela metade ou inválida falha como `config_error` (transitório).
4. Não troque o par de chaves depois que há inscrições: as inscrições antigas deixam de valer: o serviço de push recusa o envio (esperado 401/403, que viram `config_error`; não conferido em produção).
5. iPhone: o aviso só chega com o app instalado na tela inicial (iOS 16.4 ou mais novo). No Safari comum não há push.
6. O endpoint do aparelho só é aceito se o host está na lista de serviços de push (`src/lib/notifications/push-endpoint.ts`). O worker confere de novo antes de enviar; host fora da lista falha como `invalid_endpoint` (permanente), sem chamada de rede. O envio não segue redirecionamento.
7. Códigos de erro:
   - `push_gone`: o serviço respondeu 404 ou 410. A inscrição é apagada na hora. A notificação vai para `failed`.
   - `subscription_gone`: a inscrição já não existe (logout, desligar o aviso, conta encerrada ou aparelho de outro perfil). A notificação vai para `failed`.
   - `invalid_endpoint`: endpoint fora da lista.
   - `rate_limited` (429), `provider_unavailable` (5xx), `provider_timeout`, `network_error`: transitórios, com a mesma espera das outras vias.
   - `provider_rejected`: outro 4xx ou 3xx. Permanente.
8. A inscrição é removida quando a conta é encerrada e quando o cliente toca em "Sair" (botão do portal e da tela de aceite). Sair por outra página, sessão expirada ou inatividade (30 min) mantém a inscrição até o caminho 410 (`push_gone`) apagá-la. Aparelho compartilhado fica protegido: quem se inscreve depois assume o endpoint (upsert) e o perfil anterior deixa de receber.
   - Evento 1 (sócio autorizou o SCR): não há push quando o sócio é o próprio comprador (mesmo e-mail do perfil, sem diferença de caixa): ele acabou de autorizar.
   - Se enfileirar o aviso falhar, o banco registra um `warning` (`push enqueue failed (<template>): sqlstate <código>`, sem dado pessoal) e a operação de origem (captura, liberação de comissão ou de entrega, autorização SCR) segue.
9. O texto do aviso é fixo no código (`src/lib/notifications/push-payload.ts`): título com o nome da marca e uma frase curta. Nunca CPF, CNPJ, valor ou nome.

(post-deploy) Com as chaves reais: ligue o aviso no portal pelo aparelho, gere um evento (por exemplo, a liberação de uma pesquisa) e confirme que o aviso chega. No iPhone, repita com o app instalado. Em `reino_notifications_cron`, o lote não mostra `push_gone` nem `config_error` para esse aparelho.
