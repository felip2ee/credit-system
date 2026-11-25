# App do admin do bureau — design

## Intenção
O admin do bureau precisa de uma jornada simples, com cara de app separado. Ele vê os links do bureau e as métricas logo na home. Ele cria uma consulta PF/PJ para um cliente e gera o link de pagamento no nome dele. O superadmin vê e edita os links de cada bureau.

## Objetivos
- App instalável (PWA) em `/admin`, mesmo domínio, mesmo login e cookie.
- Menu de 4 itens: Início, Nova consulta, Cobranças, Links.
- Home: links do bureau (copiar), métricas e ranking de afiliados.
- Nova consulta: escolher cliente PF/PJ e produto, então gerar ou enviar link de pagamento.
- Superadmin: listar e editar o slug (`/b/<slug>`) de cada bureau.

## Não objetivos
- Subdomínio real ou domínio por bureau (risco de cookie `__Host-` e `trustedOrigins`).
- Remover ou alterar o dashboard atual em `(dashboard)`.
- Novo tipo de link além de `/b/<slug>` e do código de afiliado.

## Anti-objetivos
- Cliente pagar duas vezes a mesma consulta pelo mesmo link.
- Número de CPF/CNPJ completo em link, log ou auditoria.
- Admin de um bureau ver dados de outro bureau.

## Abordagens (escolhida: A nas duas partes)
- App: A) grupo de rotas `/admin` com layout próprio e manifest. B) simplificar o dashboard atual. Escolhida A: separa a jornada sem tocar na autenticação.
- Pagamento: A) tabela `payment_links` e página pública `/pagar/<token>`, Pix gerado na abertura. B) Pix direto, expira em 30 min. Escolhida A: dá para reenviar.

## Partes

### 1. Shell `/admin` + PWA
- Rotas em `src/app/admin/`. Mesma guarda de papel do `(dashboard)/layout.tsx`. Cliente vai para `/portal`.
- `manifest.webmanifest` com `start_url: /admin`, `scope: /admin`. Reusar o service worker existente em `src/lib/pwa/`.
- Home: cartões com `/b/<slug>` e link de afiliado (botão copiar), métricas, ranking.

### 2. Métricas e visitas
- Reusar `getDashboardMetrics` e `getRevenueSummary` (`src/lib/dashboard/queries.ts`). Respeitar `canViewRevenue`.
- Cadastros, vendas, faturamento, número de afiliados e ranking vêm de dados existentes (`affiliate_referrals`, orders, `BureauAffiliatesTable`).
- **Visitas não existem hoje.** Nova tabela `bureau_page_views` (migration `NNN_`): `bureau_id`, `day`, `count`. Contagem agregada por dia, sem IP, sem cookie, sem dado pessoal. Incrementar em `src/app/b/[slug]/page.tsx` com upsert. Bots não filtrados (limite conhecido).
- Período: reusar `REVENUE_PERIODS`.

### 3. Consulta guiada + link de pagamento
- Fluxo: buscar/criar cliente (`searchHolders`), escolher produto do catálogo, `openCounterOrderAction` abre a consulta, então botão "Gerar link".
- Tabela `payment_links`: `id`, `bureau_id`, `order_id`, `token` (aleatório, 32 bytes, guardar hash), `expires_at` (7 dias), `status`, `created_by`. RLS por bureau.
- Página pública `/pagar/<token>`: valida token e expiração, cria cobrança Pix via `src/lib/wallet/pix-charges.ts` (escopo `client`, TTL 30 min, reusar cobrança pendente), mostra QR e copia-e-cola. Marca o link como pago pelo webhook Asaas existente. Link pago não gera nova cobrança.
- Action `createPaymentLinkAction`: zod `safeParse`, sessão, `hasPermission(role, "orders:create")`, query, evento de auditoria na mesma transação, `{ error, id? }`.
- Envio: copiar link. WhatsApp via `https://wa.me/?text=` no navegador (sem custo, sem integração). E-mail fica para depois.
- Página pública mostra só nome do bureau, produto e valor. CPF/CNPJ mascarado.

### 4. Superadmin: links
- Em `bureaus/[id]` mostrar link público como link clicável com botão copiar e total de afiliados.
- Editar slug no `BureauEditForm`/`updateBureau` com `SLUG_PATTERN` e lista de slugs reservados. Evento de auditoria.
- Redirect: tabela `bureau_slug_history` (`old_slug` único, `bureau_id`, `changed_at`). `updateBureau` grava o slug antigo na mesma transação da troca. Em `/b/[slug]` (e `entrar`, `cadastro`): se o slug não existe em `bureaus`, buscar em `bureau_slug_history` e responder redirect temporário (307) para o slug atual, mantendo o subcaminho.
- Colisão: um slug novo não pode ser igual a um `old_slug` de outro bureau. Se o bureau volta ao próprio slug antigo, apagar essa linha do histórico. Cadeia de trocas (a→b→c): todos os antigos apontam para `bureau_id`, então redirecionam direto para o slug atual.
- Teste obrigatório: troca de slug, redirect, colisão e retorno ao slug antigo.
- Lista de bureaus no superadmin com coluna do link.

## Restrições
- Raw SQL com `withUserTransaction`, auditoria na mesma transação, UI em pt-BR, migrations novas sem editar as aplicadas.
- Atualizar `docs/architecture.md` e `PRODUCT.md` (domínio único mantido).

## Fica para o construtor
- Layout visual das telas (seguir `docs/design.md`).
- Nome exato das permissões e colunas de `payment_links`.
- Se "Cobranças" lista só links ou também cobranças de balcão.
- Se o slug já é editável hoje em `updateBureau`.

## Pós-deploy
- Instalar o app no celular e abrir `/admin`.
- Pagar um link real com Pix e conferir a baixa pelo webhook.
