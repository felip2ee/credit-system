# Código e arquitetura

## Stack efetiva

Versões vêm de `package.json`. O lockfile fixa as versões exatas.

| Item | Valor |
|---|---|
| Runtime | Node 22 (CI), npm |
| Framework | Next.js 14.2.35, App Router |
| UI | React 18, Tailwind 3.4, shadcn/ui (Radix), lucide-react |
| Formulários | react-hook-form 7, zod 3, `@hookform/resolvers` |
| Dados no cliente | `@tanstack/react-query` 5 (um único `QueryClient`) |
| Banco | PostgreSQL 18, driver `pg` 8.21.0, sem ORM |
| Auth | Better Auth 1.7.2 |
| PDF | `@react-pdf/renderer` 4 |
| E-mail | nodemailer 9 |
| IA | `openai` 6 |
| Testes | Vitest 4, Playwright 1.62.1, `node --test`, `unittest` (Python) |
| Deploy | Docker Swarm, imagens do GHCR |

Decisões fora do padrão: sem ORM e sem Drizzle (veja "Decisões").

## Mapa do código

```
src/
  middleware.ts          Gate de borda: checa o cookie de sessão, redireciona para /login.
  instrumentation.ts     Cria o superadmin na subida (ensureSuperadmin).
  app/
    (auth)/ (login, MFA)   (dashboard)/ (equipe do Bureau)   (portal)/ (cliente)
    (superadmin)/          autorizacao-scr/[token]/ (SCR público)   b/[slug]/ (vitrine)
    api/                   auth, health (live/ready), webhooks (asaas, whatsapp),
                           internal/notifications/dispatch, payouts/[id]/receipt
  actions/               Server Actions ("use server").
  lib/<domínio>/queries.ts   SQL parametrizado, uma função por operação.
  lib/db/                Pool único, withUserTransaction, permissões.
  lib/auth/              Config do Better Auth, getRequiredSession, helpers.
  lib/audit/             Eventos de auditoria append-only.
  lib/deps/              Cliente do bureau DEPS Mix V3 (sem mock; fixtures em __fixtures__/).
  lib/ai/                Parecer de crédito (OpenAI), validado por src/types/ai.ts.
  lib/pdf/ documents/ email/   PDFs, armazenamento com varredura ClamAV, nodemailer.
  lib/notifications/     Fila (outbox), render, despacho, canais (email, whatsapp), webhook da Meta.
  lib/validators/        Schemas zod.
  components/            Pastas por funcionalidade + ui/ (shadcn).
  types/ test/
db/migrations/           Migrations SQL numeradas.
scripts/                 db (migrate, reset), setup (Python), notifications-cron, verify-release.
e2e/                     Specs Playwright (login com MFA, compra no portal e balcão até `ready`). Veja [quality.md](quality.md).
docker/ docker-compose.dev.yml docker-stack.yml
```

Outros domínios em `src/lib/`: asaas, bureaus, catalog, consultations, counter-payments, dashboard, dossiers, holders, lgpd, nfse, payables, payouts, scr, settings, settlement, support, wallet.

Responsabilidade por módulo: veja os `CLAUDE.md` em `src/components/`, `src/lib/{ai,auth,db,deps,documents,pdf}` e `src/actions/`.

## Fronteiras e fluxo

Fluxo de uma mutação:

1. O `middleware` barra requisições sem cookie de sessão. Ele não autoriza.
2. A Server Action valida a entrada com `safeParse` do zod (`src/lib/validators/`).
3. A action chama `getRequiredSession` e `hasPermission(role, "<recurso>:<verbo>")`.
4. A action chama uma função de `src/lib/<domínio>/queries.ts` dentro de `withUserTransaction({ userId, role }, fn)`.
5. A query grava o dado e o evento de auditoria na mesma transação.
6. A action chama `revalidatePath` e devolve `{ error: string | null, id? }`.

Regras:

- Uma query devolve `{ ok: false, reason }` para conflito de negócio. Outros erros lançam exceção e revertem a transação.
- Nenhum `PoolClient` sai de um módulo `queries`.
- Componentes não acessam o banco. Eles chamam actions.
- A autorização real fica em actions e queries. O RLS do Postgres é a segunda barreira.

Webhooks e worker:

- `POST /api/webhooks/asaas` e `/api/webhooks/whatsapp` recebem eventos externos. Eles usam a role `app_webhook` (`DATABASE_WEBHOOK_URL`).
- Uma notificação entra na fila (tabela no Postgres) na mesma transação da regra de negócio.
- O serviço `notifications_cron` (`scripts/notifications-cron.mjs`) chama `POST /api/internal/notifications/dispatch` a cada 60 s, com `NOTIFICATIONS_DISPATCH_SECRET`.
- O despacho tenta de novo com espera crescente. Veja [operations/notifications.md](operations/notifications.md).
- `POST /api/internal/orders/tick` executa os pedidos de pesquisa com a identidade de sistema do Bureau (perfil `is_system`), sem sessão. Veja [operations/orders.md](operations/orders.md). O mesmo tick roda a varredura de retenção LGPD (`src/lib/lgpd`).
- O cron também envia alertas por e-mail: indisponibilidade, falha de envio, erro no tick e backup atrasado. Veja [operations/monitoring.md](operations/monitoring.md).

## Dados e migrations

- Migrations: `db/migrations/NNN_nome_snake_case.sql`, de `001` a `028`. Os números 006 e 007 não existem (hipótese: removidos antes do primeiro deploy).
- A 021 cria as contas de cliente: `legal_documents`, `legal_acceptances`, `verification_challenges`, `client_register_attempts`, e as funções `register_client` e de verificação (`request_*` e `confirm_*` de e-mail e de telefone).
- A 023 cria a retenção LGPD: anonimização do titular e da conta do cliente, varredura técnica e do Bureau. Veja [operations/lgpd.md](operations/lgpd.md).
- A 022 cria os pedidos de pesquisa (`dossier_orders`, com estado protegido por trigger), a função `open_order` (única porta de criação de Dossiê), o perfil de sistema por Bureau (`profiles.is_system`) e a RLS de entrega do cliente. Veja [operations/orders.md](operations/orders.md).
- A 024 dá ao cliente leitura de `bureau_payloads` só de pedido próprio em `released` (`bureau_payloads_client_released`).
- A 025 cria as operações do cliente sobre o próprio pedido: `cancel_client_order` (cancela em `awaiting_authorization` ou `ready` e libera a reserva; motivo `cancelled_by_client`), `client_order_members` (membros do pedido com o estado do aceite SCR e documento mascarado) e `record_order_declaration`. Cria a tabela imutável `order_declarations` (um aceite por pedido, com versão, IP e user agent) e o tipo `buyer_declaration` em `legal_documents`.
- A 026 cria o núcleo de afiliados: `affiliate_codes` (um código de 8 caracteres por cliente, criado pelo trigger de `profiles`), `affiliate_referrals` (vínculo imutável, criado só no cadastro), `bureau_affiliate_settings` (% padrão do Bureau), `affiliate_rates` (% por afiliado), `affiliate_wallets`, `affiliate_ledger_entries` (imutável) e `affiliate_commissions`. `register_client` recebe o código de indicação.
- A 027 põe a comissão em `capture_order` (só com `profiles.phone_verified_at` do indicado) e cria `release_due_commissions()`, que o tick de pedidos chama para encerrar a carência (`affiliate_commissions.release_at`). A configuração `affiliate_commission_hold_days` guarda os dias de carência.
- A 028 cria os saques (`affiliate_withdrawals`, com a taxa de `affiliate_withdrawal_fee`), a conversão do saldo em créditos e as funções de pagar (com comprovante) e cancelar. Veja [operations/affiliates.md](operations/affiliates.md).
- O catálogo guarda custo e venda por sócio ao lado do valor base: `product_versions.base_cost_per_partner`, `bureau_product_costs.cost_per_partner` e `bureau_catalog_items.sale_price_per_partner`. Só o Dossiê Empresarial usa o valor por sócio.
- Aplicar: `npm run db:migrate`. O runner grava checksums. Não edite uma migration já aplicada.
- A política do spec: até o primeiro deploy de produção, as migrations são uma base editável e o banco de dev é recriado com `npm run db:reset`. A partir do primeiro deploy de produção, só migrations novas (forward-only, com checksum).
- Serviço `migrate` (Swarm, one-shot): aplica as migrations com `DATABASE_OWNER_URL`, a única DSN de owner em produção. `reino_app` só tem `app_runtime` e espera o schema com `migrate.mjs --check`. Veja [operations/deploy.md](operations/deploy.md).
- Dois roles de conexão:
  - `DATABASE_URL`: role de runtime do app (`app_runtime`), sujeito ao RLS.
  - `DATABASE_OWNER_URL`: dono do schema. Usado por migrations e `db:reset`. Em produção, só o serviço `migrate` a recebe.
  - `DATABASE_WEBHOOK_URL`: role `app_webhook`, usado pelos webhooks.
- `db:reset` apaga o schema `public` e recusa hosts não locais.
- O RLS lê `app.user_id`, `app.user_role`, `app.bureau_id` e `app.support_session_id`. `withUserTransaction` define esses valores com `set_config(..., true)` (local à transação).
- Toda tabela nova precisa de política RLS na migration e de um caso em `rls.integration.test.ts`.
- Nunca reintroduza Supabase.
- Pool único em `src/lib/db/pool.ts`. `PG_POOL_MAX` define o máximo (padrão 10).
- Dev: Postgres 18 em `127.0.0.1:54329` via `docker-compose.dev.yml`.

## Decisões

| Decisão | Motivo | Revisar quando |
|---|---|---|
| SQL puro com `pg`, sem ORM | Controle do RLS e do contexto de transação. Fonte: `CLAUDE.md`. | Um ORM provar que preserva o contexto RLS. |
| SQL parametrizado em `queries.ts` | Evita injeção de SQL. Uma função por operação. | — |
| Sem logger estruturado; `console` direto | Estado atual do código. Não há módulo de log. | Decidido: sem logger; alertas pelo cron (M7). |
| Outbox no Postgres + cron, sem fila externa | Decisão D1 do spec do M4: sem infraestrutura nova. | Volume de envio exceder o worker de 60 s. |
| Livro-razão imutável | Spec de produto: saldo nunca é editável. | — |
| Migrations editáveis até o primeiro deploy | Dados de produção foram perdidos; não há compatibilidade a preservar. | Primeiro deploy de produção. |
| Tela, PDF e IA leem o payload bruto (`bureau_payloads`), não o canônico | Mostrar 100% do retorno da deps sem deploy por módulo novo (spec 2026-10-19). | Payload ultrapassar o limite de tamanho da tela ou do PDF. |
| Sem Supabase | Migrou para Postgres self-hosted com Better Auth. | — |

## Manutenção

Atualize este mapa ao alterar diretórios, dependências relevantes, contratos ou fronteiras. Registre comportamento comprovado; remova decisões que deixaram de valer.
