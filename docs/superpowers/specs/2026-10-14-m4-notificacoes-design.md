# M4 — Notificações: Desenho

**Data:** 2026-10-14
**Status:** rascunho (D1–D3 aprovadas pelo usuário; o restante aguarda revisão)
**Milestone:** M4 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)
**Issues:** #34 (parcial), #35, #36 (parcial). Ver "Ajustes nas issues".
**Depende de:** M1 (tenant, RLS por `bureau_id`, papéis). Usa a role `app_webhook` e o modelo de webhook do M3.

## Objetivo

Dar à plataforma uma camada única de envio por e-mail e WhatsApp:
- Toda notificação entra numa fila no Postgres (outbox), na mesma transação da regra de negócio que a pede.
- Um worker envia, tenta de novo com espera crescente e registra cada passo num log de entrega.
- Os templates têm versão. A notificação guarda a versão que usou.
- O WhatsApp usa a Cloud API oficial da Meta, com um só número da plataforma, e recebe o status de entrega por webhook.
- O e-mail de autorização SCR passa a sair pela fila.

O M4 não cria novos eventos de produto. O M5 (cadastro, código por WhatsApp) e o M6 (entrega) usam esta camada.

## Decisões do usuário (aprovadas, não reabrir)

| # | Decisão |
|---|---|
| D1 | **Outbox no Postgres + worker.** Route Handler chamado por cron, retentativa com backoff, chave de idempotência por notificação, auditoria na mesma transação do enfileiramento. Sem infraestrutura nova (sem fila externa, sem Redis). |
| D2 | **Escopo:** infraestrutura de canais, templates versionados, log de entrega, webhook da Meta para status, migração do e-mail de autorização SCR (`src/lib/email/scr-authorization-email.ts`, `mailer.ts`) para a fila. Código de verificação por WhatsApp fica fora (M5). |
| D3 | **WhatsApp:** Cloud API oficial, **um** WABA da plataforma, credenciais só em variáveis de ambiente (nunca no banco). Templates aprovados pela Meta: o banco guarda nome, idioma e mapa de parâmetros. O webhook verifica `X-Hub-Signature-256`. |

## Ponto de partida

- `sendScrSelfAuthorization` (`src/actions/scr-self.ts`) grava o código em `scr_authorizations` e chama `sendMail` na hora. Falha de SMTP volta como erro na tela. Não há auditoria do envio.
- `mailer.ts` lê SMTP do ambiente e não tem timeout.
- O webhook do Asaas (`src/app/api/webhooks/asaas/route.ts`) é o modelo: rota pública, autenticação por header comparada com `timingSafeEqual`, limite de corpo, nada do corpo no log, pool `app_webhook` (`getWebhookPool`), 500 só quando o reenvio ajuda.
- `writeAuditEvent` grava na transação do chamador e exige `user_id = app_user_id()`.
- O reset de senha (`src/lib/auth/email.ts`) envia direto por nodemailer. Ele fica como está (fora do escopo).

## Decisões

1. **Tabelas.** Quatro tabelas novas na migration `019_notifications.sql`:
   - `notification_templates`: template da plataforma (sem `bureau_id`; o produto não tem white-label). Chave, canal, versão, estado (`active | retired`) e lista ordenada de parâmetros. E-mail: assunto, HTML e texto com marcadores `{{nome}}`. WhatsApp: nome do template na Meta, idioma e a ordem dos parâmetros do corpo. A linha é imutável; só o estado muda. Um template ativo por chave e canal.
   - `notifications` (outbox): uma linha por envio. `bureau_id` (nulo só para teste do superadmin), template fixado no enfileiramento, destinatário, destinatário mascarado, hash do destinatário, parâmetros, chave de idempotência, `reference` (ex.: `scr_authorization:<id>`), estado, tentativas, próxima tentativa, lease, id da mensagem no provedor, último código de erro.
   - `notification_events`: log de entrega, só INSERT. Um evento por passo (`queued`, `attempt_failed`, `sent`, `delivered`, `read`, `failed`, `suppressed`, `retried`).
   - `notification_opt_outs`: canal e hash do destinatário. Vale para a plataforma inteira (um só número).
2. **Enfileiramento.** `enqueueNotification(client, identity, input)` roda na transação do chamador. Ele normaliza o destinatário, chama a função SQL `enqueue_notification` e grava a auditoria `notification.enqueue` no mesmo cliente. O Bureau vem de `app_bureau_id()`, nunca do chamador. A mesma chave de idempotência no mesmo Bureau devolve a notificação existente, sem linha nova e sem auditoria nova. Sem template ativo: `template_not_found`. Parâmetros diferentes da lista do template: `invalid_params`.
3. **Worker.** `POST /api/internal/notifications/dispatch`, autenticado por `Authorization: Bearer <NOTIFICATIONS_DISPATCH_SECRET>`. Ele pega lotes com `FOR UPDATE SKIP LOCKED` (dois crons ao mesmo tempo nunca pegam a mesma linha), envia, e grava o resultado por lease. O worker usa a role `app_webhook`, que só executa funções.
4. **Retentativa.** Erro transitório (timeout, rede, 4xx do SMTP, 429 e 5xx da Meta) volta para `pending` com espera `2^(tentativa−1)` minutos, no máximo 60 minutos, até 8 tentativas (~2 h). Erro permanente (5xx do SMTP, template ausente ou pausado na Meta, número sem WhatsApp, erro de render) vai direto para `failed`. A lease vencida (processo caiu) volta para a fila e conta como tentativa.
5. **Entrega pelo menos uma vez.** Timeout do provedor é ambíguo: a mensagem pode ter saído. O worker tenta de novo. Uma mensagem duplicada é aceita; uma mensagem perdida não.
6. **Estados.** `pending → sending → sent → delivered → read`, ou `failed`, ou `suppressed`. O status da Meta só avança: `delivered` não volta para `sent`. `failed` da Meta só vale sobre `sent`.
7. **Webhook da Meta.** `GET /api/webhooks/whatsapp` responde o desafio de verificação (`hub.verify_token`). `POST` confere `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com o app secret) antes de ler o JSON. Assinatura errada: 401. Eventos repetidos não mudam nada (chave única por mensagem e status). Status de uma mensagem ainda sem registro (corrida com o worker) fica guardado e é aplicado quando o worker grava o id.
8. **Opt-out e LGPD.** Mensagem recebida no WhatsApp com `PARAR`, `SAIR`, `STOP`, `CANCELAR` ou `DESCADASTRAR` grava opt-out. O worker não envia para destinatário com opt-out: a notificação vira `suppressed`. Todos os templates do M4 são transacionais (pedidos pelo próprio fluxo); nenhum é marketing.
9. **Dados pessoais.** Destinatário e parâmetros ficam na linha só enquanto servem ao envio. Em `sent`, `suppressed` e na resposta da Meta, o worker apaga os dois. Em `failed`, apaga depois de 7 dias (a nova tentativa manual precisa deles). Ficam o destinatário mascarado e o hash. Nunca CPF/CNPJ em parâmetro, log, evento ou auditoria. O log da aplicação registra só id, canal e código de erro.
10. **Telefone.** Formato E.164 (`+5563992345615`). Número brasileiro sem DDI ganha `+55`. Celular com 11 dígitos exige o nono dígito. O opt-out grava as duas formas do celular brasileiro (com e sem o nono dígito), porque o `wa_id` da Meta pode vir sem ele.
11. **E-mail de autorização SCR.** O HTML atual vira o template `scr_authorization` (e-mail, versão 1) na migration. `issueSelfScrAuthorization` grava o código e enfileira na mesma transação. Se o enfileiramento falhar, o código não muda. A tela mostra "na fila" em vez de "enviado", e a lista SCR mostra o estado do último envio.
12. **Acesso.** `bureau_admin` e `operator` leem as notificações e eventos do próprio Bureau, sem ver destinatário nem parâmetros (grant por coluna). O superadmin sem suporte lê todas, também mascaradas. O cliente não lê. Só funções escrevem.
13. **Permissão nova.** `notifications:manage` (superadmin): ver o log da plataforma, tentar de novo, enviar teste.

## Telas

| Rota | Quem | Conteúdo |
|---|---|---|
| `/superadmin/notifications` | `superadmin` | log de entrega (filtro por estado e canal), templates ativos, "Tentar de novo" para `failed`, "Enviar teste" |
| `/scr` (alteração) | `operator`, `bureau_admin` | selo do último envio da autorização: Na fila, Enviado, Entregue, Falhou |

## Fora do escopo

- Código de verificação e confirmação de telefone por WhatsApp (M5, #39).
- Preferência de canal por destinatário (#34): vai para o M5, que cria a conta do cliente e o telefone confirmado.
- Templates de convite, resultado pronto e liberado (#36): entram no M5 e no M6, com o evento que os dispara.
- Autorização SCR por WhatsApp: precisa de template aprovado e de telefone confirmado (M6).
- Editor de templates na tela. Template novo entra por migration.
- E-mail de reset de senha pela fila.
- Mensagens de marketing, mensagens livres fora de template, mídia.

## Critérios de pronto

Cada critério aponta para o teste que o prova.

- A mesma chave de idempotência não cria segunda notificação nem segunda auditoria (Task 1, 3).
- Dois workers ao mesmo tempo nunca pegam a mesma notificação (Task 1).
- Erro transitório reagenda com backoff; erro permanente e a 8ª falha viram `failed` (Task 1, 3).
- Lease vencida volta para a fila; resultado com lease velha é ignorado (Task 1).
- Webhook com assinatura errada recebe 401; evento repetido não muda nada; status não regride (Task 4).
- Status que chega antes do id da mensagem é aplicado depois (Task 1, 4).
- Destinatário com opt-out vira `suppressed` e não chama o provedor (Task 1, 3, 4).
- Destinatário e parâmetros somem da linha no estado final (Task 1).
- Bureau A não lê notificação do Bureau B; staff não lê destinatário nem parâmetros (Task 1).
- Telefone fora do E.164 é recusado; o nono dígito é tratado (Task 2).
- O e-mail SCR sai pela fila, com o mesmo conteúdo, e o código não muda se o enfileiramento falhar (Task 5).
- `npm run lint`, `npm run type-check` e `npm run test` passam no fim da última onda.
- (post-deploy) A Meta aprova os templates usados e o webhook fica assinado no app da Meta.
- (post-deploy) Um envio real de e-mail SCR e um teste real de WhatsApp chegam, e o status `delivered` volta pelo webhook.
- (post-deploy) O cron roda a cada minuto no stack e o log do worker não mostra dados pessoais.

## Riscos

- **Duplicidade:** timeout do provedor gera reenvio. Aceito pela regra "pelo menos uma vez".
- **Latência:** o e-mail SCR sai em até ~1 minuto (intervalo do cron), não na hora.
- **Hash de telefone:** o espaço de telefones é pequeno; o hash não anonimiza. Ele só tira o número da coluna. O acesso à tabela fica restrito às funções.
- **Opt-out sem volta:** o M4 não tem comando para sair do opt-out. Remover exige SQL do dono do banco.
- **Template na Meta:** o template pode ser pausado ou rejeitado depois de cadastrado. O envio falha com `template_unavailable` e aparece no log.
- **Role compartilhada:** worker e webhooks usam `app_webhook`. Ela continua sem acesso a tabela; só executa funções.

## Plano de tarefas (resumo para o plano de execução)

| Task | Agente | Conteúdo | Depende de |
|---|---|---|---|
| 1 | `database-architect` | migration `019_notifications.sql`: tabelas, RLS, grants por coluna, funções (enfileirar, pegar lote, concluir, status da Meta, opt-out, nova tentativa), seeds; testes de integração | — |
| 2 | `backend-specialist` | canais e render: E.164, render de e-mail, payload do WhatsApp, cliente da Graph API (driver fake), timeout no SMTP, classificação de erro, leitores de config; testes | — |
| 3 | `backend-specialist` | serviço da fila e worker: `enqueueNotification` + auditoria, `runDispatch`, rota do worker, permissão, ações do superadmin; testes | 1, 2 |
| 4 | `backend-specialist` | webhook da Meta: GET de verificação, POST assinado, status e opt-out; testes | 1, 2 |
| 5 | `backend-specialist` | e-mail SCR pela fila; testes | 3 |
| 6 | `devops-engineer` | cron no stack, segredos (setup, Docker, `runtime-secrets`), `.env.example`, `docs/operations/notifications.md` | — |
| 7 | `frontend-specialist` | `/superadmin/notifications` e selo na lista SCR | 3, 5 |

Ondas: {1, 2, 6} → {3, 4} → {5} → {7}. Um PR. Review uma vez, no fim, com `code-reviewer` e `security-reviewer`.

## Ajustes nas issues

- #34: fechar com o PR, exceto "Preferência de canal por destinatário"; mover esse critério para uma issue do M5.
- #35: fechar com o PR.
- #36: manter aberta. O M4 entrega só o template SCR por e-mail; os outros templates chegam com o evento que os usa (M5, M6).
