# M0 — Fundação: Desenho

**Data:** 2026-10-13
**Status:** aprovado (brainstorming)
**Milestone:** M0 de [Plataforma Bureau](2026-10-13-plataforma-bureau-produto-design.md)

## Objetivo

Um servidor novo, sem nenhum dado, sobe com `docker stack deploy`, aplica o schema, cria o superadmin e funciona. O ambiente de dev sobe com `docker compose` + `npm run dev`. O CI prova isso contra um Postgres 18 real em cada PR.

## Problemas que motivam o M0 (review de 2026-10-13)

Verificados contra um Postgres 18.6 limpo:

1. `postgres:18` recusa iniciar com volume em `/var/lib/postgresql/data` (exige `/var/lib/postgresql`). Afeta `docker-stack.yml` e `docker-compose.dev.yml`.
2. `insert into profiles (id, auth_user_id, …) values ($1, $1, …)` falha com `inconsistent types deduced for parameter $1` (`id uuid` × `auth_user_id text`) em `src/actions/users.ts` e `src/actions/portal.ts` — convite de equipe e acesso ao portal quebrados.
3. Better Auth 1.7 exige a coluna `id` em `rate_limit`; o login falha com `column rate_limit.id does not exist`.
4. Não há forma de criar o primeiro admin num banco vazio (signup desativado, só admin cria usuários).
5. Dev: rede `internal: true` impede o acesso à porta publicada; o superusuário do container se chama `app_runtime` e a migration 001 falha (`permission denied to alter role`); `.env.example` aponta `DATABASE_OWNER_URL` para um usuário `postgres` inexistente.
6. As suítes de integração nunca rodaram contra banco real (8 falhas, 23 não executadas).

## Componentes

### 1. Postgres e Docker

- Volume do Postgres montado em `/var/lib/postgresql` em `docker-stack.yml` e `docker-compose.dev.yml`.
- `docker-compose.dev.yml`: superusuário `postgres`, rede bridge comum (não `internal`), porta `127.0.0.1:54329`, mesmo init de produção (`docker/postgres/init/001-users.sh`) alimentado por compose secrets de arquivo em `docker/dev-secrets/` (valores `test`, versionados, só para dev).
- Certresolver do Traefik parametrizado: `TRAEFIK_CERT_RESOLVER` (padrão `letsencryptresolver`). Rede externa do Traefik parametrizada: `TRAEFIK_NETWORK` (padrão `RainhaNet`).

### 2. Correções de schema e auth

- `002_auth.sql`: `rate_limit` ganha `id text primary key`; `key` passa a `unique not null`.
- `users.ts` e `portal.ts`: parâmetros com cast explícito (`$1::uuid, $1::text`).
- Remover `010_must_reset_password.sql` e todos os usos de `must_reset_password`.
- Base editável: edições vão direto nos arquivos de `db/migrations/`; `npm run db:reset` (só dev, recusa rodar com `NODE_ENV=production`) derruba e recria o schema `public` e reaplica as migrations.

### 3. Superadmin automático

- `src/instrumentation.ts` (`register()`, só no runtime Node) chama `ensureSuperadmin()`.
- Entrada: `SUPERADMIN_EMAIL` (env) e `SUPERADMIN_PASSWORD` / `SUPERADMIN_PASSWORD_FILE` (secret `superadmin_password` em produção, hidratado por `runtime-secrets.mjs`).
- Comportamento:
  - e-mail ausente → não faz nada;
  - usuário com o e-mail já existe → não faz nada (nunca sobrescreve senha nem papel);
  - caso contrário → cria `user` + `account` (credential, senha com o hash do Better Auth) + `profiles` com papel `admin`, numa transação; registra auditoria `superadmin.bootstrap`.
- Senha com menos de 12 caracteres → erro claro no log e o servidor não sobe.
- Corridas entre réplicas: protegido por advisory lock e unicidade do e-mail.
- MFA obrigatório no primeiro login (já implementado em `session.ts`).
- M1 introduz o papel `superadmin` e promove este usuário.

### 4. Script de setup de produção

`scripts/setup/setup_production.py`, Python 3.10+, somente biblioteca padrão.

- Pergunta (com padrões quando fizer sentido): domínio da aplicação; rede externa e certresolver do Traefik; CIDR do proxy (sugerido via `docker network inspect <rede>`); SMTP host, porta, TLS, usuário, senha, remetente; e-mail do superadmin e senha (digitada ou gerada); e-mail e senha DEPS, centro de custos; chave OpenAI e modelo; e-mail de alerta de backup; dono da imagem e digests (opcionais, podem ser preenchidos depois).
- Gera com `secrets`: senhas de `postgres`, `schema_owner`, `app_runtime`, `backup_reader`; `better_auth_secret` (64 hex); `restic_password`; senha do superadmin se pedido. Monta as DSNs `database_url` e `database_owner_url`.
- Saídas:
  - `.env.production` (0600) apenas com valores não secretos, consumido por `set -a; . ./.env.production; set +a; docker stack deploy -c docker-stack.yml reino`;
  - Docker secrets via `docker secret create` (stdin, nunca argv). Secret já existente é pulado com aviso (secrets do Swarm são imutáveis);
  - `credenciais-GUARDAR.txt` (0600) com todos os valores, para mover a um gerenciador de senhas e apagar do servidor.
- Flags: `--dry-run` (mostra o que faria, não grava nada), `--no-docker` (só arquivos), `--output-dir`.
- Recusa sobrescrever `.env.production` existente sem `--force`.
- Arquivos gerados entram no `.gitignore`.
- Estrutura extensível para Asaas (M3) e WhatsApp (M4).
- Testes `unittest` para geração, validação de entradas (domínio, e-mail, porta, CIDR, tamanho de senha), renderização do `.env` e montagem dos comandos `docker secret`.

### 5. Limpeza

Remover:

- `scripts/migration/*`, scripts npm `migration:*`, gate 11 de `scripts/verify-release.mjs`;
- `supabase/`, `docs/legacy/`, `scripts/check-no-supabase*.mjs` e o script npm correspondente;
- `docs/operations/cutover.md`, `rollback.md`, `migration-rehearsal.md` (o `security-checklist.md` é revisto para refletir setup do zero);
- CRM de oportunidades, financiamento imobiliário e comissão: páginas `opportunities/*` e `settings/commission`, actions, componentes `opportunities/*` e `settings/commission-form`, `lib/opportunities`, `lib/orders`, `lib/checklists`, validador `opportunity`, tabelas, políticas RLS, índices e storage de documentos de oportunidade, links na sidebar e no portal, e os testes correspondentes. O que for compartilhado (armazenamento de documentos, ClamAV) permanece.

### 6. Testes e CI

- Suítes de integração leem `TEST_DATABASE_URL` (padrão `postgres://app_runtime:test@localhost:54329/credit_system`) e `TEST_DATABASE_OWNER_URL`.
- `.github/workflows/ci.yml` em pull requests e pushes para `main`: `npm ci`, lint, type-check, vitest unitário, `node --test`, `python -m unittest`, serviço Postgres 18.6 com init de roles, `db:migrate`, vitest de integração, `next build`.
- `verify-release.mjs` atualizado para os gates restantes.
- Playwright fica para o M7.

### 7. Documentação

`README.md` em português: visão curta, dev (`docker compose -f docker-compose.dev.yml up -d`, `npm run db:migrate`, `npm run dev`, superadmin via `.env.local`), produção (script Python → deploy), testes. `.env.example` e `.env.local.example` atualizados.

## Fora do escopo

Multi-tenant e novo modelo de domínio (M1); o lote PJ atual não é corrigido porque será substituído pelo Dossiê. Backup fora do servidor e retirada da DSN de superusuário do container do app (M7).

## Critérios de pronto

- `docker compose -f docker-compose.dev.yml up -d` + `npm run db:migrate` + `npm run dev` funcionam numa máquina limpa.
- Com `SUPERADMIN_EMAIL`/senha definidos, o superadmin é criado na primeira subida, faz login e configura TOTP; uma segunda subida não altera nada.
- Convidar consultor funciona.
- `setup_production.py --dry-run` e `--no-docker` produzem arquivos corretos; testes Python passam.
- Num Swarm de teste, `docker stack deploy` com os artefatos do script sobe Postgres, aplica migrations e cria o superadmin.
- CI verde, incluindo as suítes de integração.
- Nenhuma referência restante a Supabase, oportunidades, financiamento imobiliário ou comissão.
