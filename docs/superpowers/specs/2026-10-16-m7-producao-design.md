# M7 — Produção: Desenho

**Data:** 2026-10-16
**Status:** rascunho. O usuário não estava disponível. O agente tomou todas as decisões (D1–D22). As decisões com risco de negócio ou jurídico estão em "Decisões a confirmar" e precisam de aprovação antes da onda 1.
**Milestone:** M7 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)
**Issues:** #47, #48, #49, #50, #51, #52.
**Depende de:** M0–M6 (tudo em `main` desde o PR #68). Branch: `feature/m7-producao` a partir de `main`.

## Decisões a confirmar

| # | Decisão tomada | Alternativa | Custo se errada | Tasks |
|---|---|---|---|---|
| D1 | Um só repositório Restic, em storage S3-compatível (B2, R2 ou S3). O volume local `restic_repo` sai da stack. | Manter repositório local e copiar para o S3 com `restic copy`. | Dependência de um provedor externo; sem cópia local para restore rápido. | 1, 2 |
| D2 | A DSN de owner do serviço de migração continua sendo a do superusuário `postgres` (como hoje). Trocar para `schema_owner` fica fora do M7. | Migrar com `schema_owner`. | As migrations 001–022 fazem `alter ... owner to auth_profile_lookup`, que exige superusuário ou membro do papel. A troca exigiria revisar as 22 migrations. | 1 |
| D3 | Monitoramento sem Sentry nem Prometheus: alertas por e-mail do próprio `notifications_cron`, healthchecks do Swarm e um monitor externo de uptime em `GET /api/health/ready` (configuração manual, pós-deploy). Agregação de erros = `docker service logs` filtrado pelos prefixos `[...]` dos `console.error`. | Sentry (`@sentry/nextjs`). | Sem stack trace agregado e sem histórico de erros fora dos logs do Docker (10 MB x 3 arquivos). Dado pessoal não sai para terceiro. | 3, 7 |
| D4 | Prazos de retenção (tabela abaixo) são hipóteses: 5 anos para dados de consulta, consentimento, financeiro e auditoria; horas ou dias para dados técnicos. Precisam de validação do contador ou advogado antes do primeiro deploy. | Outros prazos. | Prazo curto: perda de prova fiscal ou de consentimento SCR. Prazo longo: dado pessoal retido sem base. | 4, 7 |
| D5 | Exclusão a pedido = anonimização. Ficam: autorizações SCR (prova de consentimento), razão, pagamentos, repasses, NFS-e e `audit_logs` (LGPD art. 16, I: obrigação legal). Saem: identificação do Titular, payload DEPS, resultado canônico, pareceres e notas. | Apagar as linhas. | Na alternativa, perde-se prova de consentimento e trilha fiscal. Na escolha, o nome e o documento ficam em `scr_authorizations` até o fim do prazo de 5 anos. | 4 |
| D6 | O pedido do titular é atendido pela equipe do Bureau (`bureau_admin`) na ficha do Titular: exportar JSON e anonimizar, com motivo. Sem autoatendimento no portal. | Botões "Baixar meus dados" e "Excluir conta" no portal. | O cliente depende do Bureau para exercer o direito. Prazo legal de resposta: 15 dias. | 4, 5 |
| D7 | Anonimizar a conta do cliente é uma ação separada, oferecida na mesma ficha quando o Titular tem `client_profile_id`. Recusa saldo diferente de zero ou pedido aberto. Não toca outros Titulares comprados por aquele cliente. | Anonimizar em cascata os Titulares de terceiros do cliente. | Na alternativa, apaga-se dado de terceiro sem pedido dele. | 4, 5 |
| D8 | O e2e não chama a DEPS nem a OpenAI: os fluxos de compra e de balcão terminam no estado `ready` (pago e autorizado). A execução da consulta fica coberta pelos testes de integração com cliente DEPS falso. Sem driver `fake` novo. | Driver `DEPS_DRIVER=fake` (como `ASAAS_DRIVER=fake`) para o e2e ir até o PDF liberado. | Sem prova ponta a ponta da execução e da entrega. A alternativa custa um módulo novo em `src/lib/deps/`. | 6 |
| D9 | O primeiro deploy é ação manual do usuário com o runbook, não um job do CI. Os critérios de #52 que só a produção confirma são "(post-deploy)" e viram um item "Post-deploy follow-up" no PR, que mantém `Closes #52`. Depois do deploy, `db/migrations/` vira forward-only (o checksum já existe em `migrate.mjs`). | Job de deploy no GitHub Actions. | Sem SSH do CI no servidor, nada automatiza. Deploy manual exige disciplina de digest. | 7 |

## Objetivo

Deixar a plataforma pronta para o primeiro cliente real:
- O backup sai do servidor e o restore drill mensal alerta por e-mail (#47).
- O container do app não guarda a DSN de superusuário; um serviço one-shot migra (#48).
- Indisponibilidade, fila parada, webhook falhando e backup atrasado geram alerta (#49).
- A plataforma tem política de retenção escrita e aplicada, e atende exportação e exclusão a pedido do titular (#50).
- Login + MFA, compra no portal e fluxo de balcão rodam no Playwright a cada PR (#51).
- O servidor novo sobe com o script, o checklist de segurança está verificado e as migrations passam a ser forward-only (#52).

## Ponto de partida

- `docker/app-entrypoint.sh` roda `node scripts/db/migrate.mjs` a cada start do app; `docker-stack.yml` entrega `database_owner_url` (superusuário) ao serviço `reino_app`.
- `scripts/db/migrate.mjs` já tem `schema_migrations` com checksum sha256 e recusa arquivo alterado ou ausente. Não tem modo "só verificar".
- `docker/backup/`: `backup.sh` (diário 02:30), `prune.sh`, `restore-test.sh` (dia 1, 04:00) com e-mail por `curl` SMTP. `RESTIC_REPOSITORY=/srv/restic` no volume local `restic_repo`.
- `scripts/setup/setup_production.py` gera segredos e `.env.production`; não sabe de S3.
- `scripts/notifications-cron.mjs` chama `POST /api/internal/notifications/dispatch` e `POST /api/internal/orders/tick` a cada 60 s e só loga o status.
- `GET /api/health/live` responde 200 sempre; `GET /api/health/ready` testa o banco e o disco de documentos. O Swarm usa `/live`.
- Dado pessoal em claro: `holders.document`, `consultations.document`, `bureau_results.document`, `scr_authorizations.*`, payload DEPS em `bureau_payloads`, pareceres em `ai_reports` e `dossiers`. Nenhuma coluna `anonymized_at`. A única varredura de retenção é a de `notifications` (020).
- `e2e/auth.spec.ts` existe e depende de `AUTH_E2E_*` no ambiente. Sem `webServer` no `playwright.config.ts`, sem job no CI, sem TOTP de teste.

## Decisões

### Migração fora do app (#48)
- **D10.** Serviço Swarm `migrate` na mesma stack, mesma imagem do app, `command: ["node", "scripts/db/migrate.mjs"]`, `restart_policy: {condition: on-failure, delay: 5s, max_attempts: 10}`, só o segredo `database_owner_url`, rede `private`. A cada `docker stack deploy` com digest novo ele roda de novo; `pg_advisory_lock` já protege execução dupla.
- **D11.** `reino_app` perde `database_owner_url`, `DATABASE_OWNER_URL_FILE` e `RUN_MIGRATIONS`. O entrypoint espera o schema: `node scripts/db/migrate.mjs --check` com `DATABASE_URL` (`app_runtime`), até `MIGRATE_MAX_ATTEMPTS` (30) com 5 s de intervalo. Códigos de saída de `--check`: `0` schema atual, `2` migration pendente, `1` erro.
- **D12.** `migrate.mjs` concede `grant select on schema_migrations to app_runtime` logo depois do `create table if not exists`, só quando o papel existe. `hydrateSecretEnv` continua aceitando `DATABASE_OWNER_URL_FILE` (o serviço `migrate` usa).

### Backup fora do servidor (#47)
- **D13.** `RESTIC_REPOSITORY=s3:${RESTIC_S3_ENDPOINT}/${RESTIC_S3_BUCKET}` vem de `.env.production`. Segredos Docker novos: `restic_s3_access_key`, `restic_s3_secret_key`, montados em `/run/secrets/` e exportados por `load_secrets` como `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY` nos três scripts. O setup pergunta endpoint, bucket, access key e secret key (getpass). `credenciais-GUARDAR.txt` recebe os dois.
- **D14.** `restore-test.sh` já é o drill mensal com e-mail. Fica. Bucket com versionamento e sem acesso público é item do checklist (manual). O container de backup continua `root` e com credencial de escrita e delete no bucket: a defesa contra apagamento é o versionamento do bucket.

### Monitoramento (#49)
- **D15.** `scripts/notifications-cron.mjs` ganha `sendOpsAlert(key, subject, body)` por `nodemailer` (já dependência; `SMTP_*` e `SMTP_PASS_FILE` como no app) para `OPS_ALERT_TO`. Sem `OPS_ALERT_TO`, só loga. Um e-mail por chave a cada 60 min. Chaves: `dispatch_down` e `tick_down` (5 respostas seguidas não-200 ou falha de rede), `dispatch_failed` (`failed > 0` ou `errors > 0` no JSON), `tick_errors` (`errors > 0`), `backup_stale` (`/var/lib/backup/last-success` com mais de 36 h; o volume `backup_state` é montado read-only no `notifications_cron`, ambos presos ao manager). Sem e-mail de recuperação.
- **D16.** Uptime: monitor externo (UptimeRobot, Better Stack ou similar) em `GET https://<APP_DOMAIN>/api/health/ready`, a cada 1–5 min. `/ready` já é público. O healthcheck do Swarm continua em `/live` (queda do banco não deve reiniciar o app).

### Retenção LGPD (#50)
- **D17.** Tabela de retenção (hipótese, ver D4):

| Dado | Tabelas | Prazo | Ação no M7 |
|---|---|---|---|
| Código de verificação | `verification_challenges`, `verification` | 24 h após `expires_at` | delete (varredura) |
| Tentativa de cadastro por IP | `client_register_attempts` | 30 dias | delete (varredura) |
| Sessão expirada | `session` | 24 h após `expires_at` | delete (varredura) |
| Notificação | `notifications` | já existe (020) | nada |
| Titular, consulta, payload, resultado, parecer, dossiê, notas, timeline | `holders`, `consultations`, `bureau_payloads`, `bureau_results`, `ai_reports`, `dossiers`, `crm_notes`, `timeline_events`, `dossier_orders.subject_name` | 5 anos após a última consulta concluída (ou a pedido) | anonimizar (função) |
| Autorização SCR | `scr_authorizations` | 5 anos após `expires_at` | delete (varredura) |
| Pedido, razão, pagamento, repasse, NFS-e, webhook Asaas | `dossier_orders`, `order_settlements`, `*_ledger_entries`, `counter_payments`, `payouts`, `asaas_webhook_events` | 5 anos (fiscal) | manter; nada |
| Auditoria | `audit_logs` | 5 anos | manter; nada (append-only) |
| Aceite de termos | `legal_acceptances` | conta + 5 anos | manter; nada |

- **D18.** Migration `023_lgpd_retention.sql`: `holders.document`, `consultations.document` e `bureau_results.document` passam a aceitar `null`; colunas `holders.anonymized_at` e `profiles.anonymized_at`; `create or replace function public.dossier_orders_guard()` permite só a mudança `subject_name -> 'Titular anonimizado'`; funções `SECURITY DEFINER` (padrão 009/020/021: owner `auth_profile_lookup`, `search_path = pg_catalog, public`, `revoke all from public`, `grant execute to app_runtime`):
  - `lgpd_anonymize_holder(p_holder_id uuid) returns text` — `'ok' | 'not_found' | 'already_anonymized' | 'open_orders'`. Só Titular do `app_bureau_id()`. Pedido aberto = `dossier_orders.state` fora de `completed, released, cancelled, failed`. Anonimiza `holders` (name `'Titular anonimizado'`, document, email, phone, address*, neighborhood, city, state, zip_code, notes nulos, `anonymized_at = now()`), `consultations` (document, document_name, scr_email, observations, error_message, share_link nulos), apaga `bureau_results` e `bureau_payloads` das consultas, zera textos e jsonb de `ai_reports` e `dossiers`, apaga `crm_notes`, zera `timeline_events.description` e `metadata`, troca `dossier_orders.subject_name`.
  - `lgpd_anonymize_client_account(p_profile_id uuid) returns text` — `'ok' | 'not_found' | 'already_anonymized' | 'balance' | 'open_orders'`. Só perfil `client` do Bureau. `profiles` (full_name `'Conta anonimizada'`, email `'anon-<id>@anonimizado.invalid'`, phone_e164 e phone_verified_at nulos, is_active false, anonymized_at), `"user"` (name, email idem), apaga `session`, `account`, `two_factor` e `verification` do usuário. Não toca `holders`.
  - `lgpd_purge_bureau() returns jsonb` — roda com a identidade de sistema do Bureau no tick: anonimiza Titulares cuja última consulta concluída tem mais de 5 anos e sem pedido aberto; apaga `scr_authorizations` com `expires_at < now() - interval '5 years'`. Retorna contagens.
  - `lgpd_purge_technical() returns jsonb` — sem tenant: apaga as linhas da tabela de retenção com prazo em horas ou dias. Retorna contagens.
- **D19.** Permissão nova `lgpd:manage` só para `bureau_admin`. Server Action `src/actions/lgpd.ts`: `anonymizeHolderAction({holderId, reason})` e `anonymizeClientAccountAction({profileId, reason})`, motivo com 10–500 caracteres, auditoria `lgpd.anonymize_holder` / `lgpd.anonymize_client_account` com `metadata.reason` na mesma transação. Exportação: `GET /api/lgpd/holders/[id]/export` devolve JSON (`Content-Disposition: attachment`) com holder, parcerias, dossiês e pareceres, consultas com resultado canônico e `ai_reports`, autorizações SCR sem `auth_code` nem `public_token`, pedidos (estado, datas, preço), timeline e notas; auditoria `lgpd.export_holder`.
- **D20.** O tick (`runOrdersTick`) chama `lgpd_purge_technical()` uma vez por rodada sob `pg_try_advisory_lock(hashtext('lgpd_purge'))` e `lgpd_purge_bureau()` dentro do loop de cada Bureau. Varredura idempotente e barata; sem job novo.

### e2e no CI (#51)
- **D21.** `playwright.config.ts` ganha `webServer` (`npm run start`, `url: http://127.0.0.1:3000/api/health/live`, `reuseExistingServer: !process.env.CI`) e dois projetos: `setup` (`e2e/auth.setup.ts`: faz login, cadastra MFA, guarda `storageState` e o segredo TOTP em `e2e/.auth/`) e `chromium` (depende de `setup`). `e2e/global-setup.ts` semeia com `src/test/seed.ts`: um Bureau, um `operator`, um `client` com saldo, catálogo com `consulta_pf`. TOTP em `e2e/totp.ts` (RFC 6238, HMAC-SHA1, 30 s, 6 dígitos, sem dependência). Códigos SCR lidos do banco pelo `pg` (`TEST_DATABASE_OWNER_URL`). O tick é disparado pelo teste com `POST /api/internal/orders/tick` e o `NOTIFICATIONS_DISPATCH_SECRET` do CI. Specs: `login.spec.ts` (login, `/mfa/verify`, código errado recusado, logout), `portal-order.spec.ts` (compra própria até `ready`), `counter-order.spec.ts` (balcão: titular, pedido, pagamento, autorização até `ready`). `auth.spec.ts` passa a usar os usuários semeados; `AUTH_E2E_*` sai.
- **D22.** O job `test` do CI ganha, depois do `build`: `npx playwright install --with-deps chromium`, `npm run test:e2e`, upload de `playwright-report/` em falha. `retries: 1` no CI.

## Telas

- Ficha do Titular (`/holders/[id]`): seção "LGPD" visível com `lgpd:manage`: botão "Exportar dados" (download do JSON), botão "Anonimizar titular" (diálogo com motivo), botão "Anonimizar conta do cliente" quando há `client_profile_id`. Com `anonymized_at`, a ficha mostra o selo "Anonimizado em <data>" e esconde Editar, Nova consulta e Acesso ao portal.

## Fora do escopo

- Sentry, Prometheus, Grafana, logger estruturado.
- Autoatendimento LGPD no portal; exportação da conta do cliente; anonimização em cascata.
- Exclusão de `audit_logs`, razão, pagamentos e `asaas_webhook_events` depois dos 5 anos.
- Driver DEPS `fake`; e2e da execução, do parecer IA e do PDF.
- Troca da DSN de migração para `schema_owner`.
- Deploy automatizado pelo CI; blue-green; segunda réplica.
- Cópia local do backup.

## Critérios de pronto

| Issue | Critério | Prova |
|---|---|---|
| #47 | Repositório Restic em S3-compatível | `docker/backup/backup.test.sh`: `load_secrets exports AWS keys`; `docker-stack.yml` sem `restic_repo`; `test_setup_production.py`: `s3 keys are docker secrets and never in env file` |
| #47 | Restore drill mensal com alerta | já existe (`restore-test.sh`); runbook `docs/operations/deploy.md` passo "primeiro backup e drill manual" (post-deploy) |
| #47 | Segredos no setup | `test_setup_production.py`: `env file has restic s3 endpoint and bucket`, `credentials file has s3 keys` |
| #48 | Job one-shot com DSN owner | `docker-stack.yml` serviço `migrate`; `verify:release` valida a stack |
| #48 | App só com `app_runtime` | `migrate.test.mjs`: `--check exits 2 when a migration is pending`, `--check exits 0 when current`, `--check runs as app_runtime after grant`; `reino_app` sem `database_owner_url` |
| #49 | Alerta de indisponibilidade | `monitoring.md` (monitor externo, post-deploy); `notifications-cron.test.mjs`: `five consecutive failures send one dispatch_down alert` |
| #49 | Agregação de erros | `monitoring.md`: filtro de `docker service logs` por prefixo |
| #49 | Alertas de webhook/fila | `notifications-cron.test.mjs`: `failed in dispatch body sends dispatch_failed`, `tick errors send tick_errors`, `stale backup marker sends backup_stale`, `same key within 60 minutes sends nothing` |
| #50 | Prazos por tipo de dado | tabela D17 em `docs/operations/lgpd.md`; `lgpd.integration.test.ts`: `purge deletes expired technical rows and keeps fresh ones`, `purge anonymizes a holder idle for 5 years`, `purge deletes scr authorizations expired 5 years ago` |
| #50 | Exportação e exclusão a pedido | `lgpd.integration.test.ts`: `anonymize clears identification payloads results and opinions`, `anonymize refuses an open order`, `anonymize keeps scr authorizations ledger and audit`, `another bureau gets not_found`, `client account anonymize refuses non zero balance`, `client account anonymize deletes sessions and disables login`, `export has no auth_code public_token or other holder`; `lgpd.test.ts` (ação): `operator is refused`, `reason shorter than 10 chars is refused` |
| #51 | Login + MFA | `e2e/login.spec.ts` |
| #51 | Compra (até `ready`, D8) | `e2e/portal-order.spec.ts` |
| #51 | Fluxo assistido (até `ready`, D8) | `e2e/counter-order.spec.ts` |
| #52 | Setup num servidor novo | runbook `deploy.md` (post-deploy) |
| #52 | Checklist verificado | `security-checklist.md` §4 e §5 reescritos para off-site (post-deploy) |
| #52 | Migrations forward-only | `PRODUCT.md` e `db/migrations/CLAUDE.md` com a regra e a data do deploy (post-deploy) |

## Riscos

- `nodemailer` dentro do `notifications_cron`: a imagem standalone do Next só traz dependências rastreadas pelo build. O app importa `nodemailer`, então ela está em `node_modules` da imagem; a Task 3 confirma com `docker run --rm --entrypoint node <imagem> -e 'import("nodemailer")'` ou equivalente no `verify:release`.
- Anonimização e trigger `dossier_orders_guard`: a substituição da função em 023 precisa manter todas as recusas atuais (teste de regressão em `orders.integration.test.ts`).
- `drop not null` em `document`: `document_digits` é coluna gerada; com `null` ela vira `null` e a unicidade por Bureau deixa passar vários anonimizados. Verificar que nenhuma consulta assume `document` não nulo (`grep -rn "\.document" src/lib`).
- e2e flaky: fluxos dependem do tick e de leitura do banco. `retries: 1` e `expect.poll` no estado do pedido.
- Alerta por e-mail depende do mesmo SMTP do app. Se o SMTP cair, nenhum alerta sai; o monitor externo de uptime é a redundância.

## Plano de tarefas (resumo para o plano de execução)

| Task | Escopo | Especialista | Onda |
|---|---|---|---|
| 1 | `migrate.mjs --check`, entrypoint, stack: serviço `migrate`, app sem owner DSN, backup S3, cron com alertas e `backup_state` | devops-engineer | 1 |
| 2 | `docker/backup/*` em S3, `setup_production.py` com S3 e `OPS_ALERT_TO`, `.env.example` | devops-engineer | 1 |
| 3 | `notifications-cron.mjs`: alertas por e-mail | backend-specialist | 1 |
| 4 | 023, `src/lib/lgpd/*`, permissão, testes de integração | database-architect | 1 |
| 5 | Ação, rota de exportação, UI na ficha do Titular, purge no tick | backend-specialist | 2 |
| 6 | Playwright: setup, TOTP, 3 specs, `webServer`, CI | qa-automation-engineer | 1 |
| 7 | Docs: `deploy.md`, `monitoring.md`, `lgpd.md`, checklist, PRODUCT, architecture, migrations policy, quality | documentation-writer (haiku) | 3 |

## Ajustes nas issues

- #51: os critérios "Compra e consulta" e "Fluxo assistido" são atendidos até o estado `ready` (D8). Comentar na issue.
- #52: "Setup num servidor novo", "Checklist verificado" e "forward-only" são `(post-deploy)`; o PR mantém `Closes #52` e lista o follow-up.
