# Preparação local

## Pré-requisitos

- Node 22 e npm. Verifique: `node -v` mostra `v22.x`.
- Docker com Compose. Ele sobe o Postgres 18 e o ClamAV.
- Python 3.10 ou mais novo. Só o teste do script de setup precisa dele (`npm run setup:test`).
- Playwright só para e2e. Veja "Verificar".

## Primeira execução

```bash
npm ci
cp .env.local.example .env.local
docker compose -f docker-compose.dev.yml up -d --wait
DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:migrate
npm run dev
```

Depois:

1. Edite `.env.local`. O `.env.local.example` traz os valores de dev. O `.env.example` lista todas as variáveis, inclusive as de produção (Asaas, NFS-e, webhooks). Preencha SMTP, DEPS e OpenAI só se for usar. Para cartão e Pix, `.env.local.example` traz `CARD_FEE_TABLE`, `PIX_FEE_CENTS` e uma `PII_ENCRYPTION_KEY` de dev. A chave de dev é pública: não a use fora de dev. Ver [operations/payments.md](operations/payments.md).
2. Defina `SUPERADMIN_EMAIL` e `SUPERADMIN_PASSWORD` (12 a 128 caracteres). Na primeira subida com banco vazio, o app cria o superadmin.
3. Abra http://localhost:3000. Entre com essas credenciais. Configure o MFA no primeiro login.

Notas:

- `npm ci` segue o lockfile à risca, como o README e a CI. `npm install` também funciona e pode atualizar o lockfile.
- Não registre valores de segredo em arquivos versionados. `.env.local` é ignorado pelo Git.
- O `.env.example` traz os drivers de dev, por exemplo `ASAAS_DRIVER=fake` e `WHATSAPP_DRIVER=fake`. Fora de produção, mantenha `fake`.

## Banco

- O Postgres de dev escuta em `127.0.0.1:54329`. Banco: `credit_system`. As senhas de dev ficam em `docker/dev-secrets/` e valem só em dev.
- O ClamAV de dev escuta em `127.0.0.1:3310`.
- `DATABASE_OWNER_URL` aplica migrations. `DATABASE_URL` é o role de runtime do app.
- Aplique migrations: `npm run db:migrate`. Rode duas vezes: a segunda execução não muda nada.
- Recrie o banco do zero: `DATABASE_OWNER_URL=... npm run db:reset`. O comando apaga o schema `public` e recusa hosts não locais.
- Nunca use produção como ambiente de teste.

## Verificar

Testes locais, sem serviços:

```bash
npm run lint
npm run type-check
npm run test
```

`npm run test` roda `vitest run` e inclui os testes de integração, que precisam do Postgres de dev. Para só os unitários:

```bash
npx vitest run --exclude '**/*.integration.test.ts'
```

Testes que precisam de serviço:

- Integração: `npx vitest run integration.test`. Exige Postgres e as variáveis `TEST_DATABASE_URL` e `TEST_DATABASE_OWNER_URL` (a CI define as duas).
- Scripts: `npm run db:migrate:test`, `npm run setup:test`, `npm run ops:test`.
- E2E: `npm run test:e2e` roda o Playwright. Ele roda na CI e dentro de `npm run verify:release`. Exige app em execução e banco com seed em `PLAYWRIGHT_BASE_URL` (padrão `http://127.0.0.1:3000`).

Detalhes: [quality.md](quality.md).

## Agentes

Leia [AGENTS.md](../AGENTS.md). [CLAUDE.md](../CLAUDE.md) importa as mesmas instruções. Consulte [setup.md](setup.md) para skills locais, integrações e escopos configurados.

## Dificuldades conhecidas

- **Sintoma:** `npm run build` falha localmente.
  **Causa:** o build exige variáveis de ambiente de produção, por exemplo `TRAEFIK_PROXY_CIDR`.
  **Correção:** use os valores de placeholder do passo "Build" em [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DOCUMENT_ROOT`, `CLAMAV_HOST`, `CLAMAV_PORT`, `SMTP_*`, `TRAEFIK_PROXY_CIDR`, `NODE_ENV=production`).
- **Sintoma:** `npm run test` falha em `*.integration.test.ts`.
  **Causa:** o Postgres de dev não está no ar ou as variáveis de teste faltam.
  **Correção:** suba o Compose e defina `TEST_DATABASE_URL` e `TEST_DATABASE_OWNER_URL` como na CI.
- **Sintoma:** a opção de cartão não aparece no checkout.
  **Causa:** `CARD_FEE_TABLE` vazia (cartão desligado).
  **Correção:** defina `CARD_FEE_TABLE` como em `.env.local.example`. Ver [operations/payments.md](operations/payments.md).
- **Sintoma:** a recarga falha com "Pagamento indisponível. Contate o suporte.".
  **Causa:** `PII_ENCRYPTION_KEY` ausente ou inválida.
  **Correção:** confira o formato em [setup.md](setup.md) e o runbook [operations/payments.md](operations/payments.md).
