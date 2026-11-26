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
    admin/                 app do Bureau em /admin (PWA, mesmo domínio). Veja a seção "App /admin".
    pagar/[token]/         link de pagamento público (Pix sem sessão). Veja "Links de pagamento".
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

Outros domínios em `src/lib/`: asaas, bureaus, catalog, consultations, counter-payments, dashboard, dossiers, holders, lgpd, nfse, payables, payouts, payment-links, scr, settings, settlement, support, wallet. Métricas do app do Bureau: `bureau-admin`.

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
- O serviço `notifications_cron` (`scripts/notifications-cron.mjs`) chama `POST /api/internal/notifications/dispatch` a cada 10 s (`NOTIFICATIONS_CRON_INTERVAL_MS`), com `NOTIFICATIONS_DISPATCH_SECRET`. O ciclo roda dispatch, tick e dispatch de novo, para que o aviso criado no tick saia na hora.
- O despacho tenta de novo com espera crescente. Veja [operations/notifications.md](operations/notifications.md).
- `POST /api/internal/orders/tick` executa os pedidos de pesquisa com a identidade de sistema do Bureau (perfil `is_system`), sem sessão. Veja [operations/orders.md](operations/orders.md). O mesmo tick roda a varredura de retenção LGPD (`src/lib/lgpd`).
- O cron também envia alertas por e-mail: indisponibilidade, falha de envio, erro no tick e backup atrasado. Veja [operations/monitoring.md](operations/monitoring.md).

## Dados e migrations

- Migrations: `db/migrations/NNN_nome_snake_case.sql`, de `001` a `059`. Os números 006 e 007 não existem (hipótese: removidos antes do primeiro deploy).
- A 021 cria as contas de cliente: `legal_documents`, `legal_acceptances`, `verification_challenges`, `client_register_attempts`, e as funções `register_client` e de verificação (`request_*` e `confirm_*` de e-mail e de telefone).
- A 023 cria a retenção LGPD: anonimização do titular e da conta do cliente, varredura técnica e do Bureau. Veja [operations/lgpd.md](operations/lgpd.md).
- A 022 cria os pedidos de pesquisa (`dossier_orders`, com estado protegido por trigger), a função `open_order` (única porta de criação de Dossiê), o perfil de sistema por Bureau (`profiles.is_system`) e a RLS de entrega do cliente. Veja [operations/orders.md](operations/orders.md).
- A 024 dá ao cliente leitura de `bureau_payloads` só de pedido próprio em `released` (`bureau_payloads_client_released`).
- A 025 cria as operações do cliente sobre o próprio pedido: `cancel_client_order` (cancela em `awaiting_authorization` ou `ready` e libera a reserva; motivo `cancelled_by_client`), `client_order_members` (membros do pedido com o estado do aceite SCR e documento mascarado) e `record_order_declaration`. Cria a tabela imutável `order_declarations` (um aceite por pedido, com versão, IP e user agent) e o tipo `buyer_declaration` em `legal_documents`.
- A 026 cria o núcleo de afiliados: `affiliate_codes` (um código de 8 caracteres por cliente, criado pelo trigger de `profiles`), `affiliate_referrals` (vínculo imutável, criado só no cadastro), `bureau_affiliate_settings` (% padrão do Bureau), `affiliate_rates` (% por afiliado), `affiliate_wallets`, `affiliate_ledger_entries` (imutável) e `affiliate_commissions`. `register_client` recebe o código de indicação.
- A 027 põe a comissão em `capture_order` (só com `profiles.phone_verified_at` do indicado) e cria `release_due_commissions()`, que o tick de pedidos chama para encerrar a carência (`affiliate_commissions.release_at`). A configuração `affiliate_commission_hold_days` guarda os dias de carência.
- A 028 cria os saques (`affiliate_withdrawals`, com a taxa de `affiliate_withdrawal_fee`), a conversão do saldo em créditos e as funções de pagar (com comprovante) e cancelar. Veja [operations/affiliates.md](operations/affiliates.md).
- A 044 muda `open_order` no balcão: se o documento do Titular é o de um Titular do comprador, é a pesquisa própria dele (e-mail da conta, celular só se confirmado, contato digitado descartado, sem `contact_is_buyer`). O sócio com o documento de um Titular do comprador também pode usar o e-mail dele. Cria `update_order_contact`: a equipe troca ou reenvia o contato de um membro com autorização pendente em `awaiting_payment` ou `awaiting_authorization`; o token (`public_token`) muda, o código some e o aviso em fila é anulado. Em `awaiting_payment` só grava o contato (a emissão é do tick depois do pagamento). `issueSelfScrAuthorization` emite só se o token ainda é o lido (`superseded` se não). Teto de 3 pedidos novos por destinatário em 24 h, 2 minutos desde a última troca ou reenvio e 5 trocas ou reenvios por autorização em 24 h (`scr_authorizations.contact_changes_at`). A auditoria `order.update_contact` é gravada na própria função, um evento por Dossiê que usa a autorização. Veja [operations/orders.md](operations/orders.md).
- A 068 cria `update_my_order_member_email` e `client_member_change_limit()` (3) e redefine `client_order_members`. O cliente corrige ou reenvia o e-mail de um membro do próprio pedido, com a autorização `pending` no prazo, em `awaiting_payment` ou `awaiting_authorization`; `authorized`, `refused` e `expired` não editam. Mesmo mecanismo da 044 (novo `public_token`, `auth_code` nulo, prazo renovado, aviso em fila anulado na própria função, porque `supersede_notifications` não serve ao papel `client`). A função não envia: o tick emite o link novo. Limite de 3 trocas ou reenvios por autorização em 24 h e 2 minutos entre eles, no mesmo `contact_changes_at` da equipe. A auditoria `order.member_email_update` e `order.member_resend` usa só e-mail mascarado. Veja [operations/orders.md](operations/orders.md).
- A 069 adds a daily cap of 10 actions per user. Refused attempts write the audit event `order.member_email_attempt`. It adds a cap per phone number (3 pending authorizations in 24 h, same as `open_order`), runs `revoke select (scr_email)`, and `client_order_members` now masks only `s.email`.
- A 048 cria os cupons: `coupons`, `coupon_products` e `coupon_redemptions` (RLS com `enable` e `force`; o admin do Bureau lê e escreve; o cliente não lê). Acrescenta `coupon_id` e `discount` em `order_settlements`, os tipos `coupon_cost` e `coupon_refund` em `bureau_payable_entries`, e faz `payable_buckets` e `create_payout` contá-los. Permissões `coupons:read` e `coupons:write`, só para o admin do Bureau. Veja a seção [Cupons](#cupons).
- A 049 redefine `reserve_order` (com `p_coupon_code`), `capture_order` e `release_order`. Cria `coupon_preview` (prévia para o cliente, sem ler a tabela) e a função interna `coupon_release_redemption`. Ordem das travas: cupom (advisory lock `coupon:<id>`), liquidação, carteira do cliente, repasse (`payout:<bureau>`), carteira do Bureau.
- A 050 redefine `apply_asaas_payment`: o estorno conta `coupon_cost` e `coupon_refund` no saldo a repassar, com o mesmo conjunto de `payable_buckets`. Nada mais muda.
- A 051 corrige a revisão dos cupons: o estorno de recarga do Bureau não trava mais o pedido com cupom (captura e devolução), `order_reservation_left` desconta as reservas de cupom, a reserva repete a checagem de idempotência e os lançamentos da carteira do Bureau levam o motivo `cupom`.
- A 052 limita as tentativas de código de cupom: 10 erros por hora por cliente (`coupon_attempt_misses`). `coupon_preview` grava o erro; `reserve_order` só confere o limite.
- A 053 fecha a brecha da ação do pedido: o pedido dá rollback com cupom inválido, então `placeOrder` grava o erro por `coupon_record_miss()` numa transação própria já confirmada (`src/lib/coupons/record-miss.ts`).
- A 054 troca a conta de erros por vagas de tentativa e fecha a corrida do limite: `coupon_attempt_begin()` serializa por cliente (trava consultiva), confere 10 por hora e grava a vaga antes de avaliar o código, numa transação própria já confirmada. Só o sucesso do pedido apaga a vaga (`coupon_attempt_clear`); vaga que sobra conta como erro (fecha fechado). `coupon_preview` pega a mesma trava. `coupon_record_miss` some (`src/lib/coupons/attempt-slot.ts`).
- A 055 define o modelo de comissão. Preço de venda (`product_versions.sale_price` e `sale_price_per_partner`) é do superadmin, por versão; produto sem preço não está à venda. `product_versions.base_cost` e `base_cost_per_partner` são custo interno da plataforma. A % global do Bureau fica em `settings` (`bureau_commission_pct`); o override por Bureau, em `bureau_commission_rates` (append-only). O bloqueio de produto por Bureau fica em `bureau_product_blocks` (append-only). `order_settlements` grava `commission_pct` e `bureau_commission` no snapshot da reserva. Pedido sem `commission_pct` usa o modelo anterior. A % de afiliados é `bureau_affiliate_settings.default_pct`, uma por Bureau. As tabelas `bureau_catalog_items`, `bureau_product_costs` e `affiliate_rates` ficam só para histórico. Só o Dossiê Empresarial usa o valor por sócio.
- A 056 cria o app do Bureau: `bureau_page_views` (visitas por dia, sem IP), `bureau_slug_history` (slugs antigos, para o redirect 307) e `payment_links` (só o hash do token). Dá ao `app_runtime` o `UPDATE` de `bureaus.slug`. Escrita de visitas só por `record_bureau_page_view`.
- A 057 faz `record_bureau_page_view` contar o dia de Brasília, a mesma base dos períodos das métricas.
- A 058 liga o Pix ao link: `pix_charges.payment_link_id` (uma cobrança pendente por link), `counter_payments.pix_charge_id` (único, torna a baixa idempotente) e as funções `payment_link_charge_reserve`, `_bind`, `_cancel`, `_payer` e `apply_payment_link_charge`. Novos resultados de webhook: `link_paid`, `link_duplicate`, `link_ignored`, `link_order_not_payable`. A 060 acrescenta `link_refund_ignored` (estorno ou chargeback de Pix de link: registra em log e não mexe na consulta; estorno antes do pagamento marca a cobrança como `refunded`).
- A 061 fecha a corrida entre Pix de link e pagamento de balcão: `apply_payment_link_charge` sempre lança o Pix de valor igual ao da cobrança (o pedido só avança pelo `refresh_order_state`) e devolve `link_overpaid` quando a soma passa o preço; estorno antes do pagamento cobre cobrança `expired`/`cancelled`. O balcão (`registerCounterPayment`, `voidCounterPayment`) trava o pedido primeiro e recusa pedido fora de `awaiting_payment` e valor acima do saldo.
- A 062 tira o e-mail de confirmação do cadastro: `register_client` não cria desafio nem notificação (o usuário nasce com `email_verified = false`) e `request_phone_verification` não exige mais e-mail verificado. `request_email_verification` e `confirm_email_verification` continuam para links já enviados.
- A 059 faz `platform_bureau_metrics()` devolver `affiliate_count` (total de afiliados por Bureau). Ela lê `affiliate_codes` por dentro, porque a RLS bloqueia o superadmin fora de suporte.
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
- Falta = `max(custo − preço pago, 0)`. Desde a 055, "custo" é a parte da plataforma (preço bruto menos a comissão do Bureau): a falta é o desconto que passa da comissão do Bureau. Comissão e afiliado valem sobre o preço bruto e o afiliado sai da parte da plataforma (veja o spec de comissão, 3.6). O Bureau cobre a falta, nesta ordem:
  1. Saldo disponível da carteira pré-paga do Bureau (`wallets`). Reserva na reserva do pedido e captura na captura.
  2. O que sobra sai do repasse já liberado, com lançamento `coupon_cost` (negativo). Saldo retido não cobre.
  3. Se ainda falta, o cupom é recusado (`coupon_funds_insufficient`). O pedido não abre.
- Preço pago maior ou igual ao custo: falta zero. A margem só diminui. Acréscimo do Bureau = `max(comissão − desconto, 0)`; o afiliado é pago sobre o bruto, mesmo com margem zero.
- Liberação, cancelamento e expiração devolvem tudo: redenção `released`, carteira do Bureau liberada e `coupon_refund` (positivo) devolve ao repasse o valor que saiu dele.
- Estorno depois da captura devolve só o que o cliente pagou. `coupon_cost`, a captura da carteira do Bureau e a redenção `consumed` não são desfeitos.

## App /admin

- Rotas em `src/app/admin/`, com layout próprio. Mesmo domínio, mesmo login e mesmo cookie de sessão. Não há subdomínio.
- Guarda em `src/app/admin/layout.tsx`, com `getRequiredSession`. Cliente vai para `/portal`. Superadmin só entra em modo suporte; sem ele, vai para `/superadmin`.
- Menu de 4 itens: Início (links do Bureau, métricas, ranking de afiliados), Nova consulta, Cobranças e Links.
- PWA: `src/app/admin/manifest.ts` gera `/admin/manifest.webmanifest`, com `start_url` e `scope` em `/admin`.
- A vitrine `/b/<slug>` e o app `/admin` usam o mesmo domínio. Não há domínio por Bureau.

## Links de pagamento

Fluxo para o cliente: [operations/payment-links.md](operations/payment-links.md).

- Um link aponta para uma consulta (`payment_links.order_id`). Só um link `active` por consulta (índice único parcial).
- O token tem 32 bytes aleatórios. O banco guarda só o hash SHA-256 (`token_hash`). A URL leva o token em claro: `/pagar/<token>`. Validade: 7 dias (`expires_at`). Depois do prazo, o status fica `active` até alguém marcá-lo `expired`. A validade vale pelo relógio.
- `/pagar/` é rota pública no `middleware`. A página mostra só o nome do Bureau, o produto e o valor. CPF/CNPJ sai mascarado.
- Ao abrir a página, cria-se uma cobrança Pix de 30 min (`pix_charges`, pela reserva com `payment_link_charge_reserve`). Uma cobrança pendente por link é reusada até expirar. A cobrança é do Bureau: `client_profile_id` nulo, sem taxa repassada. Ela nunca credita carteira. O vínculo é `pix_charges.payment_link_id`. O valor cobrado é o restante da consulta (preço menos pagamentos de balcão não anulados). Ao trocar a cobrança ou o link, o pagamento antigo é cancelado no Asaas (melhor esforço).
- Baixa: o webhook Asaas desvia para `apply_payment_link_charge`, numa transação. O link vira `paid`. Entra um `counter_payments` com `pix_charge_id` (método Pix), e `refresh_order_state` avança a consulta. Um link pago não gera nova cobrança.
- Evento repetido não baixa de novo (`link_duplicate`). Pedido que não aceita mais pagamento (pago no balcão ou cancelado) vira `link_order_not_payable`, sem pagamento de balcão.
- Dinheiro: entra na conta Asaas da plataforma. Não há repasse automático ao Bureau.

## Pagamento por pedido

- O cliente abre o pedido (`placeOrder`). Saldo que cobre o preço: reserva direta. Saldo menor: o pedido fica em `awaiting_payment` e o preço pago e o cupom vão para `order_pix_quotes` (imutável, 063).
- `createOrderPixAction` chama `runCheckout` com `orderId` e só PIX. A cobrança é uma linha de `pix_charges` com `order_id`. O valor vem da cotação: o navegador não manda valor, e uma política restritiva no banco recusa valor diferente. Um PIX vivo por pedido (`pix_charges_order_live_idx`). PIX vencido não gera outro: o tick cancela o pedido.
- Webhook: `apply_asaas_payment` desvia para `apply_order_pix_charge` (065). Numa transação, credita o preço na carteira do cliente, chama `reserve_order` com o preço e o cupom guardados e `refresh_order_state`. Resultados: `order_paid`, `order_reserve_failed`, `order_not_payable`. Os três pedem a nota do crédito.
- O webhook roda sem sessão e `reserve_order` exige cliente. O ramo monta o contexto do cliente (`app.user_id`, `app.user_role`, `app.bureau_id`) e o restaura no fim. Pega a trava do cupom antes da carteira (mesma ordem de `placeOrder`).
- Reserva recusada depois do pagamento: o valor fica como saldo, o pedido é cancelado pelo tick e o motivo é `payment_not_reserved`. Pedido já cancelado: o valor também vira saldo (`order_not_payable`).
- Estorno do PIX do pedido (`PAYMENT_REFUNDED`, 066; vários pedidos, 067): `cancel_order_after_pix_refund` compara as liquidações `reserved` do cliente com `client_wallets.reserved` (já com o estorno). Só se faltar lastro cancela (`payment_refunded`): primeiro o pedido do PIX estornado, depois os outros `awaiting_authorization`/`ready`, do maior `seq` ao menor, até cobrir. Cada um devolve ao disponível só `least(preço, lastro - preços dos que seguem)`; pedido `executing` segue o clawback na captura (`reservation_clawed_back`). Ordem global de travas: cobrança, pedidos do cliente, liquidações, carteira (`completeOrder`/`failOrder` travam o pedido primeiro).

## Visitas e slug

- `bureau_page_views` guarda uma contagem por Bureau e por dia. Sem IP, sem cookie e sem dado pessoal. O contador é gravado por `record_bureau_page_view` (ou a versão por slug), chamado por `src/lib/bureau-admin/metrics.ts`.
- Bots contam. Não há filtro (limite conhecido).
- Só a equipe do próprio Bureau lê a contagem (`bureau_page_views_staff_select`).
- Troca de slug: `updateBureau` grava o slug antigo em `bureau_slug_history` na mesma transação. Um slug que já foi de outro Bureau fica reservado para o redirect.
- `/b/<slug>` com slug que não existe em `bureaus` consulta o histórico e responde 307 (`redirect`, temporário: o 308 seria guardado pelo navegador e faria laço se o slug voltasse a ser o antigo) para `/b/<slug atual>`. Cadeia de trocas aponta direto para o slug atual, porque cada linha guarda o `bureau_id`.

## Decisões

| Decisão | Motivo | Revisar quando |
|---|---|---|
| SQL puro com `pg`, sem ORM | Controle do RLS e do contexto de transação. Fonte: `CLAUDE.md`. | Um ORM provar que preserva o contexto RLS. |
| SQL parametrizado em `queries.ts` | Evita injeção de SQL. Uma função por operação. | — |
| Sem logger estruturado; `console` direto | Estado atual do código. Não há módulo de log. | Decidido: sem logger; alertas pelo cron (M7). |
| Outbox no Postgres + cron, sem fila externa | Decisão D1 do spec do M4: sem infraestrutura nova. | Volume de envio exceder o worker de 10 s. |
| Livro-razão imutável | Spec de produto: saldo nunca é editável. | — |
| Migrations editáveis até o primeiro deploy | Dados de produção foram perdidos; não há compatibilidade a preservar. | Primeiro deploy de produção. |
| Tela, PDF e IA leem o payload bruto (`bureau_payloads`), não o canônico | Mostrar 100% do retorno da deps sem deploy por módulo novo (spec 2026-10-19). | Payload ultrapassar o limite de tamanho da tela ou do PDF. |
| Cartão usa a tabela `pix_charges` (coluna `billing_type`). Não há `card_charges`. | Webhook, estorno, comissão de afiliado, NFS-e e superadmin já leem `pix_charges`. O nome da tabela é legado. | — |
| Dados do dono (documento, CEP e número) em `payer_profiles`, cifrados na aplicação com AES-256-GCM. Um blob por linha. Anel de chaves em `PII_ENCRYPTION_KEY`. | Dados completos não ficam em claro no banco. Um IV, uma tag e uma escrita por linha. A chave antiga decifra durante a rotação. | — |
| Busca cliente Asaas por CPF/CNPJ antes de criar. Só atualiza cliente que o sistema criou para aquele dono. | Evita clientes duplicados. Impede que alguém altere os dados do cliente Asaas de outra pessoa com o CPF dela. | — |
| Taxas do Asaas repassadas ao pagador: cartão (`CARD_FEE_TABLE`) e Pix (`PIX_FEE_CENTS`). Em `pix_charges`: `amount` = recarga (saldo, estorno), `fee_amount` = taxa, `total_charged` = recarga + taxa (valor cobrado, conferido no webhook e usado pela NFS-e; nulo no Pix sem taxa). Migration 045. | Decisão do dono: repassar todas as taxas. A recarga é a base do crédito e do estorno; a taxa não entra no saldo. | O Asaas mudar a taxa da conta ou o dono decidir absorver a taxa. |
| Stack e instalador entregam ao `reino_app` as variáveis do Asaas, da NFS-e, do cartão (`CARD_FEE_TABLE`, `PIX_FEE_CENTS`) e a chave PII. | Sem elas, `readAsaasConfig` falha em produção e a recarga não funciona. | — |
| Link de pagamento com token guardado como hash SHA-256 | Quem lê o banco não consegue abrir um link. O token em claro só existe na URL. | — |
| Pix do link reusa a cobrança `pix_charges`, sem tabela nova | Webhook, estorno e NFS-e já leem `pix_charges`. A cobrança de link é um caso com `payment_link_id`. | Link ganhar regra própria de cobrança (parcelas, outro meio). |
| Visitas agregadas por dia, sem IP e sem cookie | Métrica do Bureau sem dado pessoal e sem consentimento de cookie. | Precisar de visitante único ou de filtro de bots. |
| Sem Supabase | Migrou para Postgres self-hosted com Better Auth. | — |

## Manutenção

Atualize este mapa ao alterar diretórios, dependências relevantes, contratos ou fronteiras. Registre comportamento comprovado; remova decisões que deixaram de valer.
