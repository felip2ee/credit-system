# Plataforma Bureau

Plataforma multi-tenant de diagnósticos de crédito PF/PJ (Next.js 14, Better Auth, PostgreSQL 18 com RLS, Docker Swarm).
Roadmap e decisões: [docs/superpowers/specs/2026-10-13-plataforma-bureau-produto-design.md](docs/superpowers/specs/2026-10-13-plataforma-bureau-produto-design.md).

## Documentação

- [Produto e escopo](PRODUCT.md).
- [Preparação local](docs/onboarding.md).
- [Estrutura e decisões técnicas](docs/architecture.md).
- [Design e acessibilidade](docs/design.md).
- [Checks de qualidade](docs/quality.md).
- [Instruções para agentes](AGENTS.md).
- [Setup e evidências](docs/setup.md).

## Desenvolvimento local

`npm run dev` sobe só o Next. O app também precisa do Postgres e do ClamAV (Docker), das migrations aplicadas e de um worker que envia os e-mails e executa os pedidos.

Requisitos: Node 22, Docker com Compose, Python 3.10+ (só para `npm run setup:test`).

### 1. Primeira vez

```bash
npm ci
cp .env.example .env.local
```

Edite o `.env.local`:

- Adicione `SUPERADMIN_EMAIL` e `SUPERADMIN_PASSWORD` (12 a 128 caracteres). Na primeira subida com o banco vazio, o app cria o superadmin.
- A seção "1. LOCAL DEV" do `.env.example` já traz valores de dev para tudo o que o app exige (`BETTER_AUTH_SECRET`, `DOCUMENT_ROOT`, drivers `fake` do Asaas e do WhatsApp, segredo do worker).
- Para enviar e-mail de verdade, troque `SMTP_*` por uma caixa real. Para consultar a DEPS de verdade, preencha `DEPS_API_*` (a DEPS não tem modo de teste: cada consulta é real). Para o parecer IA, preencha `OPENAI_API_KEY`.

### 2. Subir os serviços e o banco

```bash
docker compose -f docker-compose.dev.yml up -d --wait
mkdir -p /tmp/credit-system-documents
DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:migrate
```

- O Postgres de dev escuta em `127.0.0.1:54329` e o ClamAV em `127.0.0.1:3310`.
- Os scripts de banco (`db:migrate`, `db:reset`) não leem o `.env.local`: passe o `DATABASE_OWNER_URL` na linha de comando, como acima.

### 3. Rodar o app e o worker (2 terminais)

```bash
# terminal 1
npm run dev

# terminal 2: envia e-mails e WhatsApp da fila, executa os pedidos e libera comissões (a cada 60 s)
node --env-file=.env.local scripts/notifications-cron.mjs
```

Sem o terminal 2, os e-mails ficam na fila e os pedidos ficam parados em "Aguardando". Para rodar o worker uma vez só:

```bash
curl -X POST -H "Authorization: Bearer <NOTIFICATIONS_DISPATCH_SECRET>" http://localhost:3000/api/internal/notifications/dispatch
curl -X POST -H "Authorization: Bearer <NOTIFICATIONS_DISPATCH_SECRET>" http://localhost:3000/api/internal/orders/tick
```

### 4. Primeiro acesso

1. Abra http://localhost:3000 e entre com o superadmin. Configure o MFA no primeiro login.
2. Em Superadmin › Produtos, defina o custo e **ative** o Dossiê Pessoa Física e o Dossiê Empresarial Estruturado. Os produtos nascem inativos.
3. Crie um Bureau e convide o admin dele. O admin define o preço de venda em Configurações › Catálogo.
4. Opcional: em Superadmin › Configurações › Afiliados, defina a carência e a taxa de saque. O saque de comissão só aparece com `AFFILIATE_WITHDRAWALS_ENABLED=true`.

### Depois de reiniciar a máquina

```bash
docker compose -f docker-compose.dev.yml up -d --wait
mkdir -p /tmp/credit-system-documents
```

O container do Postgres não volta sozinho, e o `/tmp` é apagado no reinício. Sem esses dois comandos, o `npm run dev` falha com `ECONNREFUSED ... 54329` ou o `/api/health/ready` responde 503.

### Recriar o banco do zero

```bash
DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:reset
```

Apaga todos os dados de dev e reaplica as migrations. O comando recusa hosts que não são locais. Use também quando uma migration for editada (até o primeiro deploy de produção, as migrations são editáveis).

## Testes

```bash
npm run lint && npm run type-check
npm run test          # unitários e integração; o pretest migra o banco credit_system_test
npm run test:e2e      # Playwright; veja docs/quality.md para as variáveis
npm run check         # lint + type-check + test
```

- Os testes de integração usam o banco `credit_system_test` no mesmo Postgres de dev, criado pelo Compose. Se uma migration foi editada, recrie-o antes: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system_test npm run db:reset`.
- Testes do runner de migrations e do setup: `npm run db:migrate:test && npm run setup:test`.

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
