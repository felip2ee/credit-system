# Plataforma Bureau

Plataforma multi-tenant de diagnósticos de crédito PF/PJ (Next.js 14, Better Auth, PostgreSQL 18 com RLS, Docker Swarm).
Roadmap e decisões: [docs/superpowers/specs/2026-10-13-plataforma-bureau-produto-design.md](docs/superpowers/specs/2026-10-13-plataforma-bureau-produto-design.md).

## Desenvolvimento

Requisitos: Node 22, Docker, Python 3.10+.

```bash
npm ci
cp .env.local.example .env.local      # preencha SMTP/DEPS/OpenAI se for usar
docker compose -f docker-compose.dev.yml up -d --wait
DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:migrate
npm run dev
```

Antes de subir o app, adicione ao `.env.local`:

- `SUPERADMIN_EMAIL`: e-mail do superadmin.
- `SUPERADMIN_PASSWORD`: senha com 12 a 128 caracteres.

Na primeira subida com banco vazio, o app cria o superadmin a partir dessas variáveis.
Abra http://localhost:3000 e entre com essas credenciais. O MFA é configurado no primeiro login.

Recriar o banco de dev do zero: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset`.

## Testes

```bash
npm run lint && npm run type-check
npx vitest run --exclude '**/*.integration.test.ts'   # unitários
npx vitest run integration.test                         # contra o Postgres de dev
npm run db:migrate:test && npm run setup:test
```

## Produção (servidor novo)

1. No manager do Swarm, com o Traefik já rodando:
   `python3 scripts/setup/setup_production.py`
   — pergunta domínio, Traefik, SMTP, superadmin, DEPS, OpenAI e e-mail de alerta de backup; gera as senhas; grava `.env.production`,
   cria os Docker secrets e `credenciais-GUARDAR.txt` (guarde num gerenciador de senhas e apague).
   Secrets que já existem não mudam. Para testar sem gravar nada, use `--dry-run`.
2. Preencha os digests das imagens (resumo do workflow *Docker Image (GHCR)*) se não informou no passo 1.
3. `set -a; . ./.env.production; set +a; docker stack deploy -c docker-stack.yml reino`
4. Acesse `https://<domínio>`, entre com o superadmin e configure o MFA.

As migrations rodam automaticamente na subida do app. Até o primeiro deploy de produção, `db/migrations/`
é uma base editável; depois disso, apenas novas migrations.

### Flags do `setup_production.py`

| Flag | Efeito |
|------|--------|
| `--dry-run` | Mostra o que faria. Não grava arquivos nem cria secrets. |
| `--no-docker` | Grava os arquivos. Não cria os Docker secrets. |
| `--force` | Sobrescreve `.env.production` e `credenciais-GUARDAR.txt` existentes. |
| `--output-dir DIR` | Grava os arquivos em `DIR`. Padrão: diretório atual. |
