# Design system Rainha Cred — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Project override: waves and review rules in `.claude/rules/08-parallel-subagent-driven-development.md` and "Lean delivery" in `CLAUDE.md` (no per-task reviewer; implementers do not commit; the coordinator commits one conventional commit per task; one final review with `code-reviewer` + `security-reviewer`).

**Goal:** Trocar a interface para a marca única Rainha Cred, com tokens acessíveis para público mais velho, um sistema único de estados com mensagens que orientam, portal mobile first, painéis com menu no celular, PDF com cabeçalho e rodapé em código e e-mails com a identidade nova.

**Architecture:** Tokens em variáveis CSS (`src/app/globals.css`, `tailwind.config.ts`) espelhados num módulo TS (`src/lib/brand/`) que o PDF e os e-mails também usam. Componentes novos em `src/components/ui/` (família shadcn/Radix). Um módulo único de vocabulário de estados (`src/lib/ui/status.ts`) alimenta todos os selos, alertas e mensagens. Telas reorganizadas por público, sem mudar regra de negócio.

**Tech Stack:** Next.js 14 App Router, React 18, Tailwind 3.4, shadcn/ui + Radix, lucide-react, `@react-pdf/renderer` 4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-design-system-rainha-cred-design.md` (leia antes de qualquer tarefa; é a autoridade).

## Como executar (para a conversa nova, sem contexto)

1. Branch: `feature/design-system-rainha-cred` (já existe; contém dossiês, afiliados e ajuste de saldo). Confirme com `git branch --show-current`. Não trabalhe na `main`.
2. Os arquivos da marca já estão em `public/brand/rainha-cred/` (o kit original foi apagado; o `.gitignore` ignora `Rainha_Cred_SaaS/`).
3. Invoque `superpowers:subagent-driven-development` com este plano e siga `.claude/rules/08-parallel-subagent-driven-development.md` (ondas abaixo). Especialista por tarefa com `model: sonnet`.
4. Testes de integração: cada tarefa que precisa de banco usa um banco próprio, criado pelo coordenador: `docker exec credit-system-postgres-1 psql -U postgres -d credit_system -c "create database credit_system_dN_test" -c "alter database credit_system_dN_test set app.env = 'dev'"`, com `TEST_DATABASE_URL`, `TEST_DATABASE_OWNER_URL`, `TEST_DATABASE_WEBHOOK_URL`, `TEST_DATABASE_DISPATCH_URL` apontando para ele (senha `test`, usuários `app_runtime`, `postgres`, `app_webhook`, `app_dispatch`, `localhost:54329`) e `DATABASE_OWNER_URL=<owner> npm run db:reset`. Use `npx vitest run`, nunca `npm run test` durante as ondas. Apague os bancos no fim.
5. Antes de subir o app: `docker compose -f docker-compose.dev.yml up -d --wait`, `mkdir -p /tmp/credit-system-documents`, `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system npm run db:migrate` (README, seção "Desenvolvimento local").
6. Commits: o coordenador faz um commit convencional por tarefa, só com os arquivos da tarefa, terminando com a linha `Co-Authored-By` da sessão.

## Global Constraints

- Uma marca: **"Rainha Cred"**. Removidos de `src/` e dos modelos de e-mail vigentes: "Reino do Crédito", "Rainha do Crédito", "Beabá do Crédito", "Eliane Moreira". **Exceção:** razão social e CNPJ em `src/lib/scr/consent-term.ts` (`authorizedName: "Eliane Moreira - Ordem Consultoria"`, CNPJ `12.296.230/0001-29`) e nos textos legais — não mudam.
- Cores da marca: verde `#009C97` (logo, ícones, destaques, texto grande), creme `#FCEDCE`, escuro `#122C2B`. O verde da marca **não** é usado em texto comum nem como fundo de botão com texto branco; texto/botões usam um tom mais escuro do mesmo verde (referência `#007A76`, confirmar ≥ 4,5:1).
- Contraste: texto ≥ 4,5:1 (texto do portal ≥ 7:1 sobre o fundo principal), texto grande/ícones/bordas de controles/anel de foco ≥ 3:1.
- Fonte: **Atkinson Hyperlegible** (400 e 700). Web via `next/font/google`; PDF via TTF no repositório. Base 18 px no portal e nas páginas públicas, 16 px nos painéis; nunca < 14 px; no portal nunca < 16 px; linha 1,5.
- Toque: altura mínima 48 px no portal e páginas públicas, 44 px nos painéis; 8 px entre alvos.
- Estados: sempre ícone + cor + texto; nunca só cor.
- Mensagem de falha ao cliente: (1) o que aconteceu, (2) o que aconteceu com o dinheiro, (3) o que fazer agora (com botão). Sem termo técnico nem código de erro.
- Kit: `public/brand/rainha-cred/` — não redesenhar, recolorir, esticar nem criar versão horizontal/branca/preta (`LEIA-ME.txt`).
- E-mail de suporte: variável `SUPPORT_EMAIL`, padrão `suporte@rainhacred.com.br` (domínio a confirmar pelo dono).
- Sem modo escuro. Sem biblioteca de UI nova fora da família Radix. Sem mudança de regra de negócio.
- Textos em pt-BR e linguagem simples; padrões do `AGENTS.md`.
- Testes e2e selecionam por rótulo/texto (`e2e/*.spec.ts`, `e2e/fixtures.ts`): toda troca de rótulo, texto de sucesso ou controle atualiza o e2e **na mesma tarefa**. `e2e/fixtures.ts` pertence só à Tarefa 4; a Tarefa 5 relata se precisar mudá-lo.
- Implementers: especialista com `model: sonnet`. Gate: testes da tarefa verdes (2 tentativas, depois escalar).

## Review Focus

1. **Nome longo do Bureau** no cabeçalho do PDF e no portal (ex.: 60 caracteres): quebra em até 2 linhas, sem sobrepor a logo nem cortar. Teste na Tarefa 6 e na Tarefa 4.
2. **Status novo sem rótulo** no vocabulário (um status que apareça no banco e não esteja mapeado): a tela mostra o estado Erro com texto genérico em vez de quebrar ou mostrar o código. Teste na Tarefa 3.
3. **Zoom de 200% / fonte grande do sistema** no celular: as telas críticas continuam sem rolagem horizontal. Verificação na Tarefa 8 (Playwright com `deviceScaleFactor` e 360 px).
4. **Leitor de tela:** selos de estado e avisos são anunciados (`role="status"`/`role="alert"`, texto não só no ícone). Teste na Tarefa 2 e verificação axe na Tarefa 8.
5. **Saldo ausente** (cliente sem `credits:read` ou sem carteira): o cabeçalho do portal não mostra saldo nem quebra. Teste na Tarefa 4.

---

### Task 1: Fundação — tokens, fonte, ícones, metadados e troca do nome

**Agent:** `frontend-specialist` · **Depends-on:** none
**Files:**
- Modify: `src/app/globals.css`, `tailwind.config.ts`, `src/app/layout.tsx`, `src/lib/config.ts` (+ `src/lib/config.test.ts`), `src/lib/auth/config.ts`, `src/lib/email/mailer.ts` (+ `mailer.test.ts`), `src/lib/ai/prompt.ts`, `parecer-prompt.md` (onde estiver), `src/types/app.ts` (só o nome da marca, linha 1), páginas e componentes que mostram o nome (levantamento: `(auth)/login/page.tsx:58`, `components/layout/sidebar.tsx:53`, `b/[slug]/page.tsx:12`, `b/[slug]/cadastro/page.tsx:11`, `autorizacao-scr/[token]/page.tsx:8,35`, `(portal)/layout.tsx:29`, `(portal-onboarding)/layout.tsx:22`), `.env.example` (`SUPPORT_EMAIL`), `PRODUCT.md` (nome do produto)
- Create: `src/lib/brand/tokens.ts`, `src/lib/brand/contrast.ts`, `src/lib/brand/contrast.test.ts`, `src/lib/brand/brand.ts`, `src/lib/brand/brand-names.test.ts`, `src/app/icon.png`, `src/app/apple-icon.png`, `src/app/manifest.ts`
- Replace: `src/app/favicon.ico` (pelo `public/brand/rainha-cred/icones/favicon.ico`)
- **Não tocar:** `src/lib/pdf/**`, rotas `*/pdf/route.ts`, `db/migrations/**`, `src/lib/scr/consent-term.ts` (Tarefas 6 e 7 e exceção legal).

**Interfaces:**
- Produces:
  - `src/lib/brand/brand.ts`: `export const BRAND_NAME = "Rainha Cred"`; `export const BRAND_ASSETS = { logo: "/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.svg", logoPng: "/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.png", symbol: "/brand/rainha-cred/simbolo/rainha-cred-simbolo-original-transparente.svg", symbolPng: "/brand/rainha-cred/simbolo/rainha-cred-simbolo-original-transparente.png" } as const`.
  - `src/lib/brand/tokens.ts`: `export const BRAND_COLORS = { brand: "#009C97", cream: "#FCEDCE", ink: "#122C2B", primary: string, primaryForeground: string, background: string, foreground: string, muted: string, mutedForeground: string, border: string, focus: string } as const` e `export const STATE_COLORS: Record<"success" | "waiting" | "progress" | "attention" | "danger" | "neutral", { bg: string; fg: string; border: string }>` — os mesmos valores das variáveis CSS (hex).
  - `src/lib/brand/contrast.ts`: `contrastRatio(hexA: string, hexB: string): number` (fórmula WCAG 2.x de luminância relativa).
  - `config.supportEmail: string` (de `SUPPORT_EMAIL`, padrão `suporte@rainhacred.com.br`).
  - Classe utilitária de área: `.area-portal` (base 18 px) aplicada pelos layouts do portal/públicos (Tarefa 4) e base 16 px no `html`.
  - Variante de fonte: `--font-sans` = Atkinson Hyperlegible (`next/font/google`, `Atkinson_Hyperlegible`, pesos 400 e 700, `display: "swap"`).

- [ ] **Step 1: Testes que falham**
  - `contrast.test.ts`: `contrastRatio("#FFFFFF", "#000000")` ≈ 21; `contrastRatio("#009C97", "#FFFFFF")` < 4.5 (prova que o verde da marca não serve para texto); para cada par de `BRAND_COLORS`/`STATE_COLORS` usado como texto/fundo: `primaryForeground` × `primary` ≥ 4.5, `foreground` × `background` ≥ 7, `mutedForeground` × `background` ≥ 4.5, cada `STATE_COLORS[x].fg` × `.bg` ≥ 4.5, `focus` × `background` ≥ 3.
  - `brand-names.test.ts`: varre `src/**/*.{ts,tsx,md}` (exceto testes, `src/lib/pdf/**` e rotas `*/pdf/route.ts` — cobertos na Tarefa 6) e falha se achar `/Reino do Crédito|Rainha do Crédito|Beabá do Crédito|Eliane Moreira/`, com allowlist só para `src/lib/scr/consent-term.ts`.
  - `config.test.ts`: `SUPPORT_EMAIL` ausente → `suporte@rainhacred.com.br`; presente → o valor.
- [ ] **Step 2:** `npx vitest run src/lib/brand src/lib/config.test.ts src/lib/email` → FAIL.
- [ ] **Step 3:** Implemente tokens (variáveis HSL em `globals.css` + `tailwind.config.ts`, valores iguais aos de `tokens.ts`; remova `.dark` se ficar órfão), fonte, `layout.tsx` (`metadata` com título `%s · Rainha Cred`, descrição, `themeColor`, `viewport`), `manifest.ts` (nome "Rainha Cred", ícones 192/512 de `public/brand/rainha-cred/icones/`), `icon.png`/`apple-icon.png` (cópias de `icone-fundo-branco-512.png`/`-180.png`), favicon, anel de foco ≥ 3:1, `prefers-reduced-motion`, troca do nome nos arquivos listados (appName e emissor TOTP em `auth/config.ts:22,127`; remetente em `mailer.ts:29` e `config.ts:95`; textos de `prompt.ts`).
- [ ] **Step 4:** mesmo comando → PASS; `npm run type-check`; `npm run lint`.
- [ ] **Step 5 (coordenador):** `feat(brand): tokens, fonte e ícones Rainha Cred; nome único da marca`

### Task 2: Componentes base

**Agent:** `frontend-specialist` · **Depends-on:** Task 1
**Files:**
- Modify: `src/components/ui/button.tsx`, `src/components/ui/input.tsx`, `src/components/ui/badge.tsx`, `src/components/ui/card.tsx`, `src/components/ui/dialog.tsx` (só tokens/tamanhos/foco), `package.json` (só se faltar um pacote Radix: `@radix-ui/react-checkbox`, `@radix-ui/react-radio-group`, `@radix-ui/react-select`, `@radix-ui/react-toast`)
- Create: `src/components/ui/{status-badge,status-banner,empty-state,skeleton,toast,toaster,textarea,select,radio-group,checkbox,stepper}.tsx`, `src/components/ui/state-tone.ts`, `src/components/ui/state-tone.test.ts`
- **Não trocar** ainda os usos nas telas (Tarefas 4 e 5).

**Interfaces:**
- Consumes: `STATE_COLORS` (Task 1), variáveis CSS.
- Produces:
  - `type StateTone = "success" | "waiting" | "progress" | "attention" | "danger" | "neutral"` e `STATE_TONE_ICON: Record<StateTone, LucideIcon>` (`CheckCircle2`, `Clock`, `Loader2`, `AlertTriangle`, `XCircle`, `Info`) em `state-tone.ts`.
  - `<StatusBadge tone={StateTone} label={string} />` — ícone + texto, `role="status"` não; texto visível sempre.
  - `<StatusBanner tone={StateTone} title={string} description?={ReactNode} action?={ReactNode} />` — `role="alert"` para `attention`/`danger`, `role="status"` para os demais.
  - `<EmptyState icon={LucideIcon} title description? action? />`, `<Skeleton className? />`.
  - `toast({ tone: StateTone, title: string, description?: string })` + `<Toaster />` (some em ≥ 6 s, pode ser fechado, anunciado por leitor de tela).
  - `<Textarea>`, `<Select>` (Radix, com `<label>` associado), `<RadioGroup>`/`<RadioGroupItem>`, `<Checkbox>` — todos com alvo ≥ 44 px e foco visível.
  - `<Stepper steps={{ label: string; state: "done" | "current" | "todo" | "failed" }[]} />` — vertical no celular, horizontal ≥ 768 px; passo atual com texto "Agora:"; falha com ícone e texto.
  - `Button` tamanhos: `default` 48 px, `lg` 56 px, `sm` 44 px (nenhum < 44 px); `Input` 48 px, `text-base`.

- [ ] **Step 1: Testes que falham** (`state-tone.test.ts`, funções puras; não há biblioteca de DOM): `toneRole("danger") === "alert"`, `toneRole("attention") === "alert"`, `toneRole("success") === "status"`; `STATE_TONE_ICON` tem os 6 tons; `stepperAnnouncement([{label:"Pedido feito",state:"done"},{label:"Consultando",state:"current"}]) === "Agora: Consultando"`.
- [ ] **Step 2:** `npx vitest run src/components/ui` → FAIL.
- [ ] **Step 3:** Implemente (invoque as skills `ui-ux-pro-max` e `vercel:shadcn`, se disponível, antes). Pacote Radix novo só se o componente exigir.
- [ ] **Step 4:** `npx vitest run src/components`; `npm run type-check`; `npm run lint`.
- [ ] **Step 5 (coordenador):** `feat(ui): componentes acessíveis de estado, formulário, aviso e progresso`

### Task 3: Vocabulário único de estados e telas de sistema

**Agent:** `frontend-specialist` · **Depends-on:** Task 2
**Files:**
- Create: `src/lib/ui/status.ts`, `src/lib/ui/status.test.ts`, `src/lib/ui/failure-message.ts`, `src/lib/ui/failure-message.test.ts`, `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/not-found.tsx`, `src/app/loading.tsx`, e `error.tsx`/`loading.tsx` nos grupos `src/app/(portal)/`, `src/app/(dashboard)/`, `src/app/(superadmin)/`
- Modify: `src/lib/orders/labels.ts`, `src/components/consultations/query-status-badge.tsx`, `src/components/scr/scr-status-badge.tsx`, `src/components/dossiers/order-state-badge.tsx` (passam a usar `status.ts` + `StatusBadge`), `src/types/app.ts` (rótulos de consulta e SCR, linhas ~100-115, passam a vir de `status.ts`)

**Interfaces:**
- Consumes: `StateTone`, `StatusBadge`, `StatusBanner`, `EmptyState` (Task 2).
- Produces:
  - `type StatusDomain = "order" | "orderReason" | "consultation" | "scr" | "member" | "withdrawal" | "commission" | "walletEntry"`.
  - `statusInfo(domain: StatusDomain, status: string, audience: "client" | "staff"): { tone: StateTone; label: string; explanation: string; nextStep: string | null }` — status desconhecido → `{ tone: "danger", label: "Situação desconhecida", explanation: "Não conseguimos mostrar esta situação.", nextStep: "Fale com o suporte." }` (Review Focus 2).
  - `failureMessage(input: { what: string; money: "refunded" | "not_charged" | "reserved" | "none"; next: string }): { title: string; money: string | null; next: string }` com os textos do dinheiro: `refunded` → "O valor voltou para o seu saldo.", `not_charged` → "Nada foi cobrado.", `reserved` → "O valor continua reservado.", `none` → `null`.
- Vocabulário (spec, "Sistema de estados"): cliente — pedido `completed` → "Pronto, aguardando liberação do Bureau" (tom `waiting`), `released` → "Pronto para ver" (`success`), `failed` → "Não foi possível consultar" (`attention`) com explicação pelo motivo (`deps_no_data` → "Não encontramos dados para este documento.", `deps_unavailable` → "O serviço de consulta está fora do ar.", `scr_refused` → "A autorização foi recusada.", `scr_expired` → "A autorização venceu."); consulta `error` → "Não foi possível consultar"; SCR `authorized`/consulta `authorized` → "Autorizado"; esperas de terceiros (`awaiting_payment`, `awaiting_authorization`, membro `pending`) → `waiting`; internas (`ready`, `executing`, `processing`) → `progress`; `expired`/`cancelled` → `neutral` com ícone próprio e contraste AA. Cubra também saque (`open`/`paid`/`cancelled`), comissão (`pending`/`released`/`reversed`) e os tipos de lançamento de carteira de `src/components/credits/client-ledger-labels.ts` e `src/components/wallet/LedgerTable.tsx`.

- [ ] **Step 1: Testes que falham**
  - `status.test.ts`: para cada domínio, todos os valores existentes (leia de `src/lib/orders/types.ts`, `src/types/app.ts`, `src/lib/affiliates/types.ts`, e dos CHECKs nas migrations) retornam rótulo não vazio e tom válido; `statusInfo("order","failed","client").label === "Não foi possível consultar"`; `statusInfo("scr","authorized","client").label === "Autorizado"`; `statusInfo("consultation","authorized","client").label === "Autorizado"`; status inventado → tom `danger`, rótulo "Situação desconhecida"; nenhum rótulo de cliente contém `/deps|payload|erro \d|500/i`.
  - `failure-message.test.ts`: `failureMessage({ what: "Não conseguimos consultar este CPF agora.", money: "refunded", next: "Tente de novo mais tarde." })` → `{ title: "Não conseguimos consultar este CPF agora.", money: "O valor voltou para o seu saldo.", next: "Tente de novo mais tarde." }`; `money: "none"` → `money: null`.
- [ ] **Step 2:** `npx vitest run src/lib/ui src/lib/orders` → FAIL.
- [ ] **Step 3:** Implemente o módulo, ligue os 3 badges e `labels.ts` a ele, crie as telas de sistema (Erro com "Tentar de novo" e "Voltar ao início"; Não encontrada; Carregando com `Skeleton`).
- [ ] **Step 4:** `npx vitest run src/lib src/components`; `npm run type-check`; `npm run lint`. Atualize testes existentes que fixam os rótulos antigos (ex.: `src/lib/orders/labels.test.ts`), sem mudar regra.
- [ ] **Step 5 (coordenador):** `feat(ui): vocabulário único de estados e telas de erro e carregamento`

### Task 4: Portal e páginas públicas — mobile first

**Agent:** `frontend-specialist` · **Depends-on:** Task 2, Task 3
**Files:**
- Modify: `src/app/(portal)/layout.tsx`, `src/app/(portal-onboarding)/layout.tsx`, `src/app/(auth)/layout.tsx` e páginas de `(auth)` (login, mfa), páginas de `src/app/(portal)/portal/**`, `src/app/b/[slug]/**`, `src/app/cadastro/**`, `src/app/autorizacao-scr/[token]/page.tsx` (só visual; o texto do termo não muda), `src/app/termos/**`, `src/app/privacidade/**`, componentes do portal (`src/components/orders/**`, `src/components/credits/**` exceto `ClientBalanceCard.tsx`/`AdjustBalanceDialog.tsx`, `src/components/affiliates/{affiliate-link-card,commission-table,withdrawal-form,convert-form}.tsx`, `src/components/register/**`, `src/components/auth/**`, `src/components/scr/**` usados nessas páginas), `e2e/fixtures.ts`, `e2e/portal-order.spec.ts`, `e2e/affiliate.spec.ts`, `e2e/auth.setup.ts`, `e2e/auth.spec.ts`, `e2e/login.spec.ts`
- Create: `src/components/portal/{portal-header,bottom-nav,account-menu}.tsx`, `src/components/portal/nav-items.ts`, `src/components/portal/nav-items.test.ts`

**Interfaces:**
- Consumes: componentes da Task 2, `statusInfo`/`failureMessage` (Task 3), `BRAND_NAME`/`BRAND_ASSETS` (Task 1), `getClientWallet(client, clientProfileId)` (`src/lib/wallet/client-queries.ts`), `hasPermission`.
- Produces: `portalNavItems(permissions: { credits: boolean; affiliates: boolean }): { href: string; label: string; icon: LucideIcon }[]` — sempre Início (`/portal`), Pesquisas (`/portal/pesquisas`), Conta (`/portal/conta` ou o destino atual de perfil); Créditos (`/portal/credits`) só com `credits`; Afiliação dentro de Conta e como cartão na Início só com `affiliates`.
- Regras de tela (spec, "Layouts"): cabeçalho com símbolo + "Rainha Cred" + saldo (só com `credits:read` e carteira existente — Review Focus 5); barra inferior fixa no celular, itens em linha no computador; uma ação principal por tela; páginas públicas com logo completa e nome do Bureau; o pedido mostra `Stepper` (Pedido feito → Autorizações → Consultando → Pronto) e falhas com `StatusBanner` + `failureMessage`; nome longo do Bureau quebra em 2 linhas (Review Focus 1); classe `.area-portal` (18 px) nos layouts do portal, onboarding, auth e públicos.

- [ ] **Step 1: Testes que falham** (`nav-items.test.ts`): sem permissões → Início, Pesquisas, Conta; com `credits` → 4 itens com Créditos na 3ª posição; `affiliates` não adiciona item à barra.
- [ ] **Step 2:** `npx vitest run src/components/portal` → FAIL.
- [ ] **Step 3:** Implemente as telas críticas (lista na spec, "Telas críticas do cliente"), troque `<select>`/`<textarea>`/radios crus por `Select`/`Textarea`/`RadioGroup`, selos por `StatusBadge`, sucessos e erros soltos por `StatusBanner`/`toast`. Atualize os e2e listados para os rótulos novos (mantenha `getByLabel`/`getByRole` estáveis sempre que der).
- [ ] **Step 4:** `npx vitest run src/components src/lib`; `npm run type-check`; `npm run lint`; e2e: `npm run test:e2e -- portal-order affiliate login auth` (banco próprio; env do e2e no `.github/workflows/ci.yml` com `AFFILIATE_WITHDRAWALS_ENABLED=true`).
- [ ] **Step 5 (coordenador):** `feat(ui): portal e páginas públicas mobile first com a marca Rainha Cred`

### Task 5: Painéis do Bureau e do superadmin

**Agent:** `frontend-specialist` · **Depends-on:** Task 2, Task 3
**Files:**
- Modify: `src/app/(dashboard)/layout.tsx`, `src/components/layout/{sidebar,topbar,page-header,support-banner,nav-items}.tsx|ts`, `src/components/superadmin/superadmin-nav.tsx`, `src/app/(superadmin)/layout.tsx` (se existir), `src/app/(dashboard)/page.tsx`, `src/app/(superadmin)/superadmin/page.tsx`, demais páginas de `(dashboard)` e `(superadmin)` só para trocar selos/alertas/campos crus pelos componentes novos, componentes dessas áreas (`src/components/{dossiers,holders,consultations,catalog,settings,superadmin,wallet,counter-payments,payouts,lgpd}/**`, `src/components/credits/{ClientBalanceCard,AdjustBalanceDialog}.tsx`, `src/components/affiliates/{bureau-affiliates-table,withdrawal-actions,affiliate-settings-form}.tsx`), `e2e/counter-order.spec.ts`
- Create: `src/components/layout/mobile-nav.tsx`, `src/components/layout/mobile-nav.test.ts` (função pura de itens)
- **Não tocar:** `e2e/fixtures.ts` (é da Tarefa 4; relate se precisar).

**Interfaces:**
- Consumes: Task 2, Task 3, `visibleNavItems` (`src/components/layout/nav-items.ts`), `BRAND_ASSETS`.
- Produces: `<MobileNav items={NavItem[]} />` — botão "Menu" (≥ 44 px, `aria-expanded`) abre gaveta com os mesmos itens da sidebar filtrados por permissão; fecha com Esc, clique fora e ao navegar; foco preso na gaveta enquanto aberta.
- Regras: sidebar com a logo no computador; abaixo de 768 px, cabeçalho com símbolo + `MobileNav`; primeira tela de cada painel em cartões empilhados no celular (número grande + rótulo), sem tabela larga; `PageHeader` quebra linha; `SupportBanner` com `StatusBanner tone="attention"`; badges de risco (`dossiers/dossier-report-panel.tsx:45-48`, `consultations/consultation-opinion.tsx:73-76`) com ícone e texto.

- [ ] **Step 1: Testes que falham** (`mobile-nav.test.ts`): `mobileNavItems(items, permissions)` devolve os mesmos itens de `visibleNavItems` na mesma ordem; operador não vê "Afiliados" (permissão `affiliates:manage`).
- [ ] **Step 2:** `npx vitest run src/components/layout` → FAIL.
- [ ] **Step 3:** Implemente. Painéis continuam melhores no computador; no celular, tudo funciona sem rolagem horizontal da página (tabelas largas rolam dentro do próprio contêiner).
- [ ] **Step 4:** `npx vitest run src/components`; `npm run type-check`; `npm run lint`; `npm run test:e2e -- counter-order`.
- [ ] **Step 5 (coordenador):** `feat(ui): painéis com menu no celular e componentes de estado`

### Task 6: PDF com cabeçalho e rodapé Rainha Cred

**Agent:** `frontend-specialist` · **Depends-on:** Task 1
**Files:**
- Create: `src/lib/pdf/brand-frame.tsx` (cabeçalho e rodapé), `src/lib/pdf/fonts.ts`, `src/lib/pdf/fonts/AtkinsonHyperlegible-Regular.ttf`, `src/lib/pdf/fonts/AtkinsonHyperlegible-Bold.ttf`, `src/lib/pdf/fonts/OFL.txt` (baixar de `https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegible`), `src/lib/pdf/brand-frame.test.ts`
- Modify: `src/lib/pdf/consultation-document.tsx`, `consultation-full-document.tsx`, `complete-consultation-document.tsx`, `dossier-document.tsx`, `markdown-pdf.tsx`, as 3 rotas `src/app/(dashboard)/consultations/[id]/pdf/route.ts`, `src/app/(dashboard)/dossiers/[id]/pdf/route.ts`, `src/app/(portal)/portal/pesquisas/[id]/pdf/route.ts` (campo `consultante` → `BRAND_NAME`; buscam o nome do Bureau)
- Delete: `src/lib/pdf/letterhead.ts` e `public/letterhead.png` quando ficarem órfãos

**Interfaces:**
- Consumes: `BRAND_NAME`, `BRAND_ASSETS.logoPng` (ler o arquivo de `public/` como data URI, como `letterhead.ts` fazia), `BRAND_COLORS`, `config.supportEmail`.
- Produces:
  - `registerPdfFonts(): void` (idempotente; família `"Atkinson"`, pesos 400/700).
  - `<PdfBrandHeader bureauName={string} issuedAt={Date} />` e `<PdfBrandFooter supportEmail={string} />` com `fixed`; rodapé: e-mail de suporte à esquerda, "Página X de Y" à direita (`render={({ pageNumber, totalPages }) => …}`); sem Instagram e sem telefone.
  - Os 5 documentos recebem a prop `bureauName: string`; sem `Bg`/imagem de fundo; `paddingTop`/`paddingBottom` recalculados para o cabeçalho/rodapé novos.
  - Tamanhos: corpo ≥ 10 pt, tabelas ≥ 9 pt; estados de risco com texto + marcador, nunca só cor.

- [ ] **Step 1: Testes que falham** (`brand-frame.test.ts`, renderizando com `renderToBuffer`/`pdf()` como os testes existentes de `complete-consultation-document.test.ts`): o texto extraído do PDF gerado contém o nome do Bureau passado, `suporte@rainhacred.com.br` e "Página 1 de" (a logo é imagem, então não procure o nome da marca no texto); não contém "Reino do Crédito"; com `bureauName` de 60 caracteres o documento é gerado sem erro (Review Focus 1); nenhum documento importa `letterhead`.
- [ ] **Step 2:** `npx vitest run src/lib/pdf` → FAIL.
- [ ] **Step 3:** Implemente; estenda o `brand-names.test.ts` da Tarefa 1 para incluir `src/lib/pdf/**` e as rotas de PDF (remova a exclusão).
- [ ] **Step 4:** `npx vitest run src/lib/pdf src/lib/brand`; `npm run type-check`; `npm run lint`.
- [ ] **Step 5 (coordenador):** `feat(pdf): cabeçalho e rodapé Rainha Cred em código, fonte legível`

### Task 7: E-mails com a identidade Rainha Cred

**Agent:** `backend-specialist` · **Depends-on:** Task 1
**Files:**
- Create: `db/migrations/0NN_rainha_cred_email_templates.sql` (próximo número livre; hoje 032), `src/lib/notifications/brand-email.integration.test.ts`
- Modify: `src/lib/notifications/render.test.ts`, `src/lib/notifications/notifications.integration.test.ts` (expectativas de assunto/rodapé), `db/migrations/CLAUDE.md`

**Interfaces:**
- Consumes: `BRAND_COLORS` (copie os hex para o SQL; o banco não importa TS), `config.betterAuthUrl` (URL absoluta da logo), `SUPPORT_EMAIL`.
- Produces: para cada modelo semeado da plataforma em `notification_templates` (migrations 020–022), uma versão nova ativa e a anterior aposentada, **só** quando a ativa ainda é a versão semeada (modelo personalizado não é tocado). Conteúdo: logo por URL absoluta (`{{site_url}}/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.png` — use o parâmetro que os modelos já recebem para o site; se não houver, adicione o parâmetro no render), cores dos tokens, `font-family: Arial, sans-serif`, rodapé "Rainha Cred · suporte@rainhacred.com.br" (sem telefone e sem Instagram), mesmo padrão de mensagem de falha do app, assunto sem o nome antigo.

- [ ] **Step 1: Testes que falham**: integração — depois da migration, todo modelo ativo da plataforma não contém `/Rainha do Crédito|Eliane Moreira|Reino do Crédito|instagram/i` e contém "Rainha Cred" e o e-mail de suporte; um modelo personalizado inserido antes continua ativo e igual; `render` com `site_url` gera o `src` absoluto da logo.
- [ ] **Step 2:** banco próprio (`credit_system_d7_test`, ver "Como executar"); `npx vitest run src/lib/notifications` → FAIL.
- [ ] **Step 3:** Implemente a migration.
- [ ] **Step 4:** `db:reset` no banco próprio; `npx vitest run src/lib/notifications`; `npm run type-check`.
- [ ] **Step 5 (coordenador):** `feat(email): modelos de e-mail com a identidade Rainha Cred`

### Task 8: Verificação de acessibilidade, celular e guia

**Agent:** `qa-automation-engineer` · **Depends-on:** Task 4, Task 5, Task 6, Task 7
**Files:**
- Create: `e2e/a11y.spec.ts`, `e2e/mobile.spec.ts`
- Modify: `docs/design.md` (vira o guia do design system: tokens, fonte, estados, vocabulário, padrão de mensagem, componentes, regras da marca, telas críticas), `package.json` (só se precisar de `@axe-core/playwright` como devDependency), `README.md` (nada além de citar o guia, se útil)

**Interfaces:**
- Consumes: as telas das Tarefas 4 e 5.
- `e2e/a11y.spec.ts`: roda axe (`@axe-core/playwright`, regras WCAG 2.1 AA) nas 10 telas críticas do cliente e nas primeiras telas dos painéis; zero violações de `color-contrast`, `label`, `button-name`, `link-name`.
- `e2e/mobile.spec.ts`: viewport 360 × 740 (e uma rodada com `deviceScaleFactor: 2` e fonte ampliada via `page.addStyleTag({ content: "html{font-size:200%}" })` — Review Focus 3) nas telas críticas: `document.documentElement.scrollWidth <= window.innerWidth`; todo `button`, `a[href]`, `input`, `[role=button]` visível tem `getBoundingClientRect()` ≥ 44 × 44 (exceções documentadas só para links dentro de texto corrido); painel do Bureau mostra o botão "Menu" e a gaveta abre.

- [ ] **Step 1:** Escreva os dois specs.
- [ ] **Step 2:** `npm run test:e2e -- a11y mobile` (banco próprio) → corrija só ajustes pequenos de estilo que eles apontarem; se a correção for grande, relate para a tarefa dona.
- [ ] **Step 3:** Atualize `docs/design.md`.
- [ ] **Step 4:** `npm run check` (recrie `credit_system_test` antes: `DATABASE_OWNER_URL=postgres://postgres:test@localhost:54329/credit_system_test npm run db:reset`) e a suíte e2e completa → verdes.
- [ ] **Step 5 (coordenador):** `test(e2e): acessibilidade e celular nas telas críticas; guia do design system`

## Ondas

| Onda | Tarefas | Motivo |
|---|---|---|
| 1 | 1 | fundação de tudo |
| 2 | 2, 6, 7 | dependem só de 1; arquivos disjuntos (componentes, PDF, migration de e-mail) |
| 3 | 3 | usa os componentes da 2 |
| 4 | 4, 5 | dependem de 2 e 3; arquivos disjuntos (portal/público vs painéis); `e2e/fixtures.ts` só na 4 |
| 5 | 8 | fim |

Revisão única no fim (`code-reviewer` + `security-reviewer`; foco: contraste medido, textos de falha, nenhuma regra de negócio alterada, termo SCR intacto, migration de e-mail sem sobrescrever modelo personalizado). Post-deploy: observar as primeiras sessões reais de clientes idosos e registrar ajustes; confirmar o domínio do e-mail de suporte.
