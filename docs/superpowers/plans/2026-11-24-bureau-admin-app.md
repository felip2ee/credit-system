# App do admin do bureau — plano

> Execução: `superpowers:subagent-driven-development` em ondas paralelas (`.claude/rules/08-parallel-subagent-driven-development.md`). Implementadores não commitam; o coordenador commita por tarefa, em ordem.

**Meta:** app `/admin` instalável com links, métricas, consulta guiada com link de pagamento, e edição de slug com redirect no superadmin.

**Spec:** `docs/superpowers/specs/2026-11-24-bureau-admin-app-design.md`

## Restrições globais
- Raw SQL com `withUserTransaction`. Zod. Auditoria na mesma transação. UI em pt-BR. Sem ORM.
- Migrations novas em `db/migrations/NNN_snake_case.sql` (próximo número livre). Nunca editar migration aplicada.
- Nunca CPF/CNPJ completo em link, log ou auditoria. Usar a forma mascarada.
- Admin de um bureau nunca lê dados de outro (RLS e checagem de dono).
- Server Action: `safeParse`, sessão, `hasPermission`, query, `revalidatePath`, retorno `{ error: string | null, id? }`.
- Link de pagamento: validade 7 dias; token de 32 bytes aleatórios, só o hash no banco; cobrança Pix 30 min.
- Visitas: contagem diária agregada, sem IP, sem cookie.

## Foco de revisão
- Token inválido, expirado, ou de link já pago em `/pagar/<token>`: página neutra, sem criar cobrança.
- Dois cliques em "Gerar link" para a mesma consulta: um link ativo só.
- Troca de slug para o slug antigo de outro bureau: rejeitada. Cadeia a→b→c redireciona direto para c.
- Admin do bureau A abre consulta, link ou métricas do bureau B: negado.
- Bot ou refresh em `/b/<slug>` com slug inexistente: não grava visita, não quebra.

## Ondas
- W1: T1. W2: T2 ‖ T4. W3: T3 ‖ T7. W4: T5. W5: T6.

---

### T1: Migration (database-architect, sonnet)
**Files:** `db/migrations/NNN_bureau_admin_app.sql`
**Depends-on:** none
**Contrato:** três tabelas com RLS por `bureau_id`.
- `bureau_page_views(bureau_id, day date, count int)`, PK `(bureau_id, day)`.
- `bureau_slug_history(old_slug text unique, bureau_id, changed_at)`.
- `payment_links(id, bureau_id, order_id, token_hash unique, expires_at, status ['active','paid','expired','cancelled'], created_by, created_at)`. Índice parcial único em `order_id` onde `status='active'`.
- Grants para o papel do app e `app_webhook` (só `UPDATE status` em `payment_links`). Leitura pública do token via função `SECURITY DEFINER` ou papel já usado em `/b/<slug>`; seguir o padrão do projeto.
**Testes:** integração: RLS isola bureaus; índice único bloqueia 2 links ativos por consulta.

### T2: Slug editável + redirect (backend-specialist, sonnet)
**Files:** `src/lib/bureaus/queries.ts`, `src/actions/bureaus.ts`, `src/app/b/[slug]/page.tsx`, `src/app/b/[slug]/entrar/page.tsx`, `src/app/b/[slug]/cadastro/page.tsx`, testes ao lado.
**Depends-on:** T1
**Contrato:**
- `updateBureau` aceita `slug` (`SLUG_PATTERN`, reservados), grava o antigo em `bureau_slug_history` na mesma transação e escreve auditoria. Rejeita slug que é `old_slug` de outro bureau. Se voltar ao próprio antigo, apaga a linha do histórico.
- `resolveBureauSlug(slug): Promise<{ kind: "bureau"; bureau } | { kind: "redirect"; slug: string } | { kind: "missing" }>`.
- As 3 páginas usam `resolveBureauSlug` e fazem `redirect` (307, temporário: o 308 seria guardado pelo navegador e faria laço se o slug voltasse) para o slug atual, mantendo o subcaminho.
**Testes:** troca, redirect, colisão, retorno ao slug antigo, cadeia a→b→c.

### T3: Visitas + métricas (backend-specialist, sonnet)
**Files:** `src/lib/bureau-admin/metrics.ts` (+test), `src/app/b/[slug]/page.tsx` (só o incremento)
**Depends-on:** T2 (mesmo arquivo de página)
**Contrato:**
- `recordBureauVisit(bureauId: string): Promise<void>`: upsert `+1` em `(bureau_id, today)`. Falha de contagem nunca quebra a página (log com `console.error`).
- `getBureauAdminMetrics(ctx, period: RevenuePeriodKey): Promise<{ visits: number; signups: number; sales: number; revenue: number | null; affiliates: number; ranking: { name: string; sales: number; commission: number }[] }>`. `revenue` é `null` sem `canViewRevenue`. Reusar `REVENUE_PERIODS`, `getRevenueSummary` e as tabelas `affiliate_referrals`. Ranking: top 5, nome sem dado sensível.
**Testes:** soma por período, `revenue` nulo sem permissão, ranking ordenado, isolamento por bureau.

### T4: Link de pagamento (backend-specialist, sonnet)
**Files:** `src/lib/payment-links/{queries,token}.ts` (+tests), `src/actions/payment-links.ts`, `src/app/pagar/[token]/page.tsx`, `src/app/api/webhooks/asaas/` (marcar `paid`), `src/middleware.ts` (rota pública `/pagar/`)
**Depends-on:** T1
**Contrato:**
- `generateToken(): { token: string; hash: string }` (32 bytes, hash SHA-256).
- `createPaymentLinkAction(input: { orderId: string }): Promise<{ error: string | null; id?: string; url?: string }>`. Permissão de criar pedido. Devolve o link existente se já houver um ativo.
- `resolvePaymentLink(token): Promise<{ ok: true; summary: { bureauName; productName; amount; maskedDocument } } | { ok: false; reason: "invalid" | "expired" | "paid" }>`.
- A página cria ou reusa a cobrança Pix pendente (`pix-charges.ts`, escopo `client`) e mostra QR e copia-e-cola. Webhook marca `paid`.
**Testes:** token inválido/expirado/pago, link único ativo, escopo de bureau, resumo sem CPF/CNPJ completo, webhook baixa o link.

### T5: Shell `/admin` + PWA + home (frontend-specialist, sonnet)
**Files:** `src/app/admin/layout.tsx`, `src/app/admin/page.tsx`, `src/app/admin/manifest.ts`, `src/components/admin/*`, ícones em `public/`
**Depends-on:** T3
**Contrato:** mesma guarda de papel do `(dashboard)/layout.tsx`. Menu com 4 itens (Início, Nova consulta, Cobranças, Links), barra inferior no celular. Manifest: `start_url`, `scope` `/admin`, `display: standalone`. Home: cartões com `/b/<slug>` e código de afiliado (copiar), métricas e ranking de `getBureauAdminMetrics`, seletor de período. Seguir `docs/design.md` e `/ui-ux-pro-max`. Reusar o service worker de `src/lib/pwa/`.
**Testes:** guarda de papel (cliente vai a `/portal`); render condicional do faturamento sem permissão.

### T6: Nova consulta + Cobranças (frontend-specialist, sonnet)
**Files:** `src/app/admin/consulta/*`, `src/app/admin/cobrancas/*`, `src/app/admin/links/*`, `src/components/admin/*`
**Depends-on:** T4, T5
**Contrato:** passos: cliente (`searchHolders`, criar se faltar) → produto do catálogo → `openCounterOrderAction` → "Gerar link" (`createPaymentLinkAction`) com botões copiar e WhatsApp (`https://wa.me/?text=` com a URL codificada). Cobranças: lista de links com status e reenviar. Links: slug público e código de afiliado.
**Testes:** validação do formulário e estados do botão (gerado/erro). Resto é apresentação.

### T7: Superadmin: links (frontend-specialist, sonnet)
**Files:** `src/app/(superadmin)/superadmin/bureaus/[id]/page.tsx`, `src/components/superadmin/bureau-edit-form.tsx`, lista de bureaus do superadmin
**Depends-on:** T2
**Contrato:** mostrar o link público clicável com botão copiar e total de afiliados. Campo de slug no `BureauEditForm` com aviso de que o slug antigo passa a redirecionar. Coluna do link na lista.
**Testes:** erro de slug inválido ou em uso aparece no formulário.

---

Docs (`docs/architecture.md`, `PRODUCT.md`): atualizar ao final, direto com um agente haiku.

## Pós-deploy
- Instalar o app no celular e abrir `/admin`.
- Pagar um link real com Pix e conferir a baixa pelo webhook.
