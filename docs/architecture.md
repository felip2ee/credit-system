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
  lib/notifications/     Fila (outbox), render, despacho, canais (email, whatsapp, push), webhook da Meta.
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

- Migrations: `db/migrations/NNN_nome_snake_case.sql`, de `001` a `053`. Os números 006 e 007 não existem (hipótese: removidos antes do primeiro deploy).
- A 021 cria as contas de cliente: `legal_documents`, `legal_acceptances`, `verification_challenges`, `client_register_attempts`, e as funções `register_client` e de verificação (`request_*` e `confirm_*` de e-mail e de telefone).
- A 023 cria a retenção LGPD: anonimização do titular e da conta do cliente, varredura técnica e do Bureau. Veja [operations/lgpd.md](operations/lgpd.md).
- A 022 cria os pedidos de pesquisa (`dossier_orders`, com estado protegido por trigger), a função `open_order` (única porta de criação de Dossiê), o perfil de sistema por Bureau (`profiles.is_system`) e a RLS de entrega do cliente. Veja [operations/orders.md](operations/orders.md).
- A 024 dá ao cliente leitura de `bureau_payloads` só de pedido próprio em `released` (`bureau_payloads_client_released`).
- A 025 cria as operações do cliente sobre o próprio pedido: `cancel_client_order` (cancela em `awaiting_authorization` ou `ready` e libera a reserva; motivo `cancelled_by_client`), `client_order_members` (membros do pedido com o estado do aceite SCR e documento mascarado) e `record_order_declaration`. Cria a tabela imutável `order_declarations` (um aceite por pedido, com versão, IP e user agent) e o tipo `buyer_declaration` em `legal_documents`.
- A 026 cria o núcleo de afiliados: `affiliate_codes` (um código de 8 caracteres por cliente, criado pelo trigger de `profiles`), `affiliate_referrals` (vínculo imutável, criado só no cadastro), `bureau_affiliate_settings` (% padrão do Bureau), `affiliate_rates` (% por afiliado), `affiliate_wallets`, `affiliate_ledger_entries` (imutável) e `affiliate_commissions`. `register_client` recebe o código de indicação.
- A 027 põe a comissão em `capture_order` (só com `profiles.phone_verified_at` do indicado) e cria `release_due_commissions()`, que o tick de pedidos chama para encerrar a carência (`affiliate_commissions.release_at`). A configuração `affiliate_commission_hold_days` guarda os dias de carência.
- A 028 cria os saques (`affiliate_withdrawals`, com a taxa de `affiliate_withdrawal_fee`), a conversão do saldo em créditos e as funções de pagar (com comprovante) e cancelar. Veja [operations/affiliates.md](operations/affiliates.md).
- A 044 muda `open_order` no balcão: se o documento do Titular é o de um Titular do comprador, é a pesquisa própria dele (e-mail da conta, celular só se confirmado, contato digitado descartado, sem `contact_is_buyer`). O sócio com o documento de um Titular do comprador também pode usar o e-mail dele. Cria `update_order_contact`: a equipe troca ou reenvia o contato de um membro com autorização pendente em `awaiting_payment` ou `awaiting_authorization`; o token (`public_token`) muda, o código some e o aviso em fila é anulado. Em `awaiting_payment` só grava o contato (a emissão é do tick depois do pagamento). `issueSelfScrAuthorization` emite só se o token ainda é o lido (`superseded` se não). Teto de 3 pedidos novos por destinatário em 24 h, 2 minutos desde a última troca ou reenvio e 5 trocas ou reenvios por autorização em 24 h (`scr_authorizations.contact_changes_at`). A auditoria `order.update_contact` é gravada na própria função, um evento por Dossiê que usa a autorização. Veja [operations/orders.md](operations/orders.md).
- A 048 cria os cupons: `coupons`, `coupon_products` e `coupon_redemptions` (RLS com `enable` e `force`; o admin do Bureau lê e escreve; o cliente não lê). Acrescenta `coupon_id` e `discount` em `order_settlements`, os tipos `coupon_cost` e `coupon_refund` em `bureau_payable_entries`, e faz `payable_buckets` e `create_payout` contá-los. Permissões `coupons:read` e `coupons:write`, só para o admin do Bureau. Veja a seção [Cupons](#cupons).
- A 049 redefine `reserve_order` (com `p_coupon_code`), `capture_order` e `release_order`. Cria `coupon_preview` (prévia para o cliente, sem ler a tabela) e a função interna `coupon_release_redemption`. Ordem das travas: cupom (advisory lock `coupon:<id>`), liquidação, carteira do cliente, repasse (`payout:<bureau>`), carteira do Bureau.
- A 050 redefine `apply_asaas_payment`: o estorno conta `coupon_cost` e `coupon_refund` no saldo a repassar, com o mesmo conjunto de `payable_buckets`. Nada mais muda.
- A 051 corrige a revisão dos cupons: o estorno de recarga do Bureau não trava mais o pedido com cupom (captura e devolução), `order_reservation_left` desconta as reservas de cupom, a reserva repete a checagem de idempotência e os lançamentos da carteira do Bureau levam o motivo `cupom`.
- A 052 limita as tentativas de código de cupom: 10 erros por hora por cliente (`coupon_attempt_misses`). `coupon_preview` grava o erro; `reserve_order` só confere o limite.
- A 053 fecha a brecha da ação do pedido: o pedido dá rollback com cupom inválido, então `placeOrder` grava o erro por `coupon_record_miss()` numa transação própria já confirmada (`src/lib/coupons/record-miss.ts`).
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

## Cupons

Regras completas: [spec de cupons](superpowers/specs/2026-11-19-cupons-desconto-design.md). Esta seção mostra só o fluxo do dinheiro.

- O desconto é calculado no banco, em `reserve_order`. A tela só mostra a prévia (`coupon_preview`). O preço enviado é conferido pelo banco.
- Preço pago = preço de tabela − desconto. Preço pago `0` não usa a carteira do cliente. Captura e liberação também pulam o cliente.
- Falta = `max(custo − preço pago, 0)`. O Bureau cobre a falta, nesta ordem:
  1. Saldo disponível da carteira pré-paga do Bureau (`wallets`). Reserva na reserva do pedido e captura na captura.
  2. O que sobra sai do repasse já liberado, com lançamento `coupon_cost` (negativo). Saldo retido não cobre.
  3. Se ainda falta, o cupom é recusado (`coupon_funds_insufficient`). O pedido não abre.
- Preço pago maior ou igual ao custo: falta zero. A margem só diminui. Margem zero ou negativa não gera acréscimo nem comissão de afiliado.
- Liberação, cancelamento e expiração devolvem tudo: redenção `released`, carteira do Bureau liberada e `coupon_refund` (positivo) devolve ao repasse o valor que saiu dele.
- Estorno depois da captura devolve só o que o cliente pagou. `coupon_cost`, a captura da carteira do Bureau e a redenção `consumed` não são desfeitos.

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
| Cartão usa a tabela `pix_charges` (coluna `billing_type`). Não há `card_charges`. | Webhook, estorno, comissão de afiliado, NFS-e e superadmin já leem `pix_charges`. O nome da tabela é legado. | — |
| Dados do dono (documento, CEP e número) em `payer_profiles`, cifrados na aplicação com AES-256-GCM. Um blob por linha. Anel de chaves em `PII_ENCRYPTION_KEY`. | Dados completos não ficam em claro no banco. Um IV, uma tag e uma escrita por linha. A chave antiga decifra durante a rotação. | — |
| Busca cliente Asaas por CPF/CNPJ antes de criar. Só atualiza cliente que o sistema criou para aquele dono. | Evita clientes duplicados. Impede que alguém altere os dados do cliente Asaas de outra pessoa com o CPF dela. | — |
| Taxas do Asaas repassadas ao pagador: cartão (`CARD_FEE_TABLE`) e Pix (`PIX_FEE_CENTS`). Em `pix_charges`: `amount` = recarga (saldo, estorno), `fee_amount` = taxa, `total_charged` = recarga + taxa (valor cobrado, conferido no webhook e usado pela NFS-e; nulo no Pix sem taxa). Migration 045. | Decisão do dono: repassar todas as taxas. A recarga é a base do crédito e do estorno; a taxa não entra no saldo. | O Asaas mudar a taxa da conta ou o dono decidir absorver a taxa. |
| Stack e instalador entregam ao `reino_app` as variáveis do Asaas, da NFS-e, do cartão (`CARD_FEE_TABLE`, `PIX_FEE_CENTS`) e a chave PII. | Sem elas, `readAsaasConfig` falha em produção e a recarga não funciona. | — |
| Sem Supabase | Migrou para Postgres self-hosted com Better Auth. | — |

## Manutenção

Atualize este mapa ao alterar diretórios, dependências relevantes, contratos ou fronteiras. Registre comportamento comprovado; remova decisões que deixaram de valer.
