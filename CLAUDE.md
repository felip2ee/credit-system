# Reino do Crédito — CLAUDE.md

Plataforma web de CRM de crédito para o escritório de consultoria Reino do Crédito.
Fluxo central: cadastrar cliente → consultar bureau (deps.com.br) → parecer de IA → oportunidade → intermediação.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Framework | Next.js 14 (App Router) |
| Linguagem | TypeScript (strict) |
| Estilo | Tailwind CSS + shadcn/ui |
| Estado / cache | TanStack Query v5 |
| Formulários | React Hook Form + Zod |
| Backend / Auth | Supabase (Postgres + Auth + Storage + Realtime + Edge Functions) |
| IA | OpenAI API — modelo configurável via `OPENAI_MODEL` (default `gpt-4o`) |
| PDF | react-pdf |
| XLSX | SheetJS (xlsx) |
| Testes | Vitest + React Testing Library |

---

## Comandos

```bash
# Instalar dependências
npm install

# Desenvolvimento local
npm run dev

# Build de produção
npm run build

# Iniciar build de produção
npm run start

# Lint
npm run lint

# Type check
npx tsc --noEmit

# Testes unitários
npm run test

# Testes em watch
npm run test:watch

# Gerar tipos do Supabase (requer supabase CLI logado)
npx supabase gen types typescript --project-id <PROJECT_ID> > src/types/supabase.ts
```

### Variáveis de ambiente

Copie `.env.local.example` para `.env.local` e preencha:

> ⚠️ **Nunca** coloque valores reais de segredos aqui (este arquivo é versionado).
> Os valores reais ficam apenas no `.env.local` (ignorado pelo Git). Abaixo só os nomes.

```
NEXT_PUBLIC_SUPABASE_URL=         # URL do projeto Supabase
NEXT_PUBLIC_SUPABASE_ANON_KEY=    # chave publishable (pode ir ao client)
SUPABASE_SERVICE_ROLE_KEY=        # SECRETO — somente Edge Functions / server, ignora RLS
OPENAI_API_KEY=                   # SECRETO — agente de IA (parecer de crédito)
OPENAI_MODEL=gpt-4o               # modelo OpenAI — troque pelo mais avançado disponível
DEPS_API_BASE_URL=                # endpoint base da deps (API Mix V3)
DEPS_API_EMAIL=                   # bureau deps.com.br
DEPS_API_PASSWORDL=               # SECRETO — senha da deps
```

---

## Estrutura de pastas

```
credit-system/
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── (auth)/                 # rotas públicas (login, recuperar senha)
│   │   │   ├── login/
│   │   │   └── reset-password/
│   │   ├── (dashboard)/            # rotas protegidas — layout com sidebar
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx            # Dashboard
│   │   │   ├── clients/
│   │   │   │   ├── page.tsx        # Listagem de clientes
│   │   │   │   ├── new/page.tsx    # Cadastro
│   │   │   │   └── [id]/page.tsx   # Ficha do cliente
│   │   │   ├── consultations/
│   │   │   │   ├── page.tsx        # Histórico
│   │   │   │   ├── new/page.tsx    # Nova consulta
│   │   │   │   └── [id]/page.tsx   # Resultado + parecer
│   │   │   ├── opportunities/
│   │   │   │   ├── page.tsx        # Lista / Kanban
│   │   │   │   └── [id]/page.tsx   # Ficha da oportunidade
│   │   │   ├── scr/
│   │   │   │   └── page.tsx        # Autorizações SCR (abas)
│   │   │   ├── batch/
│   │   │   │   └── page.tsx        # Processamento em lote
│   │   │   └── settings/
│   │   │       └── page.tsx        # Configurações
│   │   └── api/                    # Route Handlers (Next.js)
│   │       ├── deps/               # proxy / webhook deps.com.br
│   │       └── ai/                 # disparo manual de parecer
│   │
│   ├── components/
│   │   ├── ui/                     # shadcn/ui (gerados — não editar manualmente)
│   │   ├── layout/                 # Sidebar, TopBar, PageHeader
│   │   ├── clients/                # ClientCard, ClientForm, ClientTimeline
│   │   ├── consultations/          # ConsultationForm, ScrPopup, OpinionCard
│   │   ├── opportunities/          # OpportunityForm, DocumentChecklist, PipelineBadge
│   │   ├── scr/                    # ScrStatusBadge, ScrTable
│   │   ├── batch/                  # BatchUpload, BatchProgress
│   │   └── shared/                 # DataTable, EmptyState, ConfirmDialog, FileUpload
│   │
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts           # createBrowserClient
│   │   │   ├── server.ts           # createServerClient (Server Components / Actions)
│   │   │   └── middleware.ts       # refreshSession no middleware
│   │   ├── deps/
│   │   │   ├── client.ts           # wrapper da API deps.com.br
│   │   │   ├── real.ts             # client real (DEPS Mix V3)
│   │   │   └── errors.ts           # DepsScrPendingError (HTTP 400 = SCR pendente)
│   │   ├── ai/
│   │   │   └── opinion.ts          # geração de parecer via OpenAI API
│   │   └── utils.ts                # cn(), formatCPF(), formatCNPJ(), formatCurrency()
│   │
│   ├── hooks/
│   │   ├── use-clients.ts
│   │   ├── use-consultations.ts
│   │   ├── use-opportunities.ts
│   │   └── use-scr.ts
│   │
│   ├── actions/                    # Server Actions (mutações)
│   │   ├── clients.ts
│   │   ├── consultations.ts
│   │   ├── opportunities.ts
│   │   └── scr.ts
│   │
│   ├── types/
│   │   ├── supabase.ts             # gerado pelo CLI do Supabase
│   │   └── app.ts                  # tipos de domínio (Client, Consultation, Opportunity…)
│   │
│   └── middleware.ts               # proteção de rotas + refresh de sessão
│
├── supabase/
│   ├── migrations/                 # SQL de migrations (versionado)
│   ├── functions/                  # Edge Functions (Deno)
│   │   ├── ai-opinion/             # disparo pós-consulta → OpenAI API
│   │   └── deps-webhook/           # recebe callbacks da deps
│   └── seed.sql                    # dados iniciais (produtos, admin)
│
├── public/
├── .env.local.example
├── CLAUDE.md
└── app.md                          # escopo do produto (fonte da verdade)
```

---

## Fases de desenvolvimento

### Fase 0 — Fundação
- Setup Next.js 14 + Supabase + TypeScript + Tailwind + shadcn/ui
- Schema inicial do banco: `clients`, `consultations`, `opportunities`, `timeline_events`, `scr_authorizations`, `documents`
- Autenticação: login, MFA TOTP nativo do Supabase, logout por inatividade, recuperação de senha
- Layout base: sidebar, navegação, proteção de rotas via middleware
- Gestão de usuários (admin cria consultores)
- ~~Mock da API deps.com.br para desbloquear desenvolvimento~~ (removido em 2026-06-12 — em produção; o client agora exige as credenciais da deps)

### Fase 1 — CRM Core
- Cadastro e listagem de clientes PF e PJ
- Vinculação de sócios (PF ↔ PJ)
- Busca automática de CNPJ via API pública da Receita Federal
- Ficha do cliente com estrutura de timeline (sem eventos ainda)

### Fase 2 — Consultas e SCR
- Integração deps.com.br: nova consulta PF e PJ
- Verificação de autorização SCR + popup (solicitar / consultar sem SCR)
- Armazenamento do resultado da consulta
- Módulo de Autorizações SCR: abas Pendentes / Concedidas / Histórico
- Polling de status SCR via Edge Function (ou webhook deps → Edge Function)

### Fase 3 — Agente de IA
- Edge Function disparada automaticamente após consulta concluída
- Geração de parecer estruturado via OpenAI API
- Prompt base editável pelo admin na tabela de configurações
- Exibição do parecer na ficha da consulta
- Botão "Abrir Oportunidade" quando Apto / Apto com ressalvas
- Eventos da IA registrados na timeline do cliente

### Fase 4 — Oportunidades
- Criação de oportunidade a partir de consulta
- Formulário completo de crédito PJ
- Checklist de documentos + upload (Supabase Storage)
- Pipeline de status: NOVA → DOCUMENTAÇÃO → ANÁLISE → ENVIADO → APROVADO/RECUSADO
- Timeline da oportunidade (log imutável)

### Fase 5 — Operações em escala
- ✅ Dashboard com métricas reais (consultas do dia/semana/mês, pipeline de status, SCR, processos)
- ✅ Histórico de consultas: filtros, export CSV, download PDF
- ✅ Processamento de empresa: container de um CNPJ + CPFs dos sócios (operador digita), consultas individuais organizadas juntas e parecer técnico consolidado do quadro societário (`/batch`)
- ✅ Configurações: edição dos system prompts dos analisadores PF, PJ e Empresa pelo admin (tabela `settings`, aba `/settings/prompts`) — implementa o item "prompt editável" da Fase 3


### Fase 6 — Opcionais (priorizar com o cliente)
- Relatórios e gráficos (taxa de conversão, compliance SCR)
- Interface avançada do agente de IA
- Checklist de documentos PF
- Portal do cliente

---

## Convenções de código

### Geral
- TypeScript strict — sem `any` explícito
- Exports nomeados em todo lugar; default export somente em page.tsx e layout.tsx (exigência do Next.js)
- Arquivos em `kebab-case`; componentes React em `PascalCase`

### Componentes
- Um componente por arquivo
- Props tipadas com `interface`, nunca `type` para props de componente
- Composição via children e slots — evitar prop drilling além de 2 níveis; usar Context ou TanStack Query
- Server Components por padrão; adicionar `"use client"` somente quando necessário (interatividade, hooks de browser)

### Formulários
- React Hook Form + Zod em todos os formulários
- Schema Zod definido no mesmo arquivo do componente ou em `lib/validators/<entidade>.ts` se reutilizado
- Nunca usar `any` em `register()` — tipar via `z.infer<typeof schema>`

### Data fetching
- Server Components fazem fetch direto via `createServerClient` do Supabase
- Client Components usam TanStack Query (`useQuery` / `useMutation`)
- Mutações via Server Actions em `src/actions/` — nunca chamar Supabase diretamente de um event handler client-side

### Banco de dados
- Migrations em `supabase/migrations/` — nunca alterar o banco manualmente em produção
- RLS habilitado em todas as tabelas — política mínima de acesso por `auth.uid()`
- Tipos gerados pelo CLI do Supabase em `src/types/supabase.ts` — não editar manualmente

### Nomenclatura
```
// Hooks
use-<entidade>.ts           → use-clients.ts

// Server Actions
<ação><Entidade>            → createClient, updateOpportunityStatus

// Componentes de feature
<Entidade><Papel>           → ClientForm, OpportunityTimeline, ScrStatusBadge

// Handlers em componentes
handle<Ação>                → handleSubmit, handleStatusChange
```

### Estilo
- Tailwind classes direto no JSX — sem CSS Modules, sem styled-components
- Usar `cn()` de `lib/utils.ts` para classes condicionais
- Variantes de componente via `cva` (já incluso no shadcn/ui)
- Nenhuma cor hardcoded — sempre usar tokens do tema Tailwind

### Integração deps.com.br
- Todo acesso à API deps passa por `lib/deps/client.ts`
- O client exige `DEPS_API_BASE_URL` + `DEPS_API_EMAIL` + `DEPS_API_PASSWORDL`; sem elas, lança erro (não há mock)
- Nunca expor credenciais da deps em código client-side — todas as chamadas à deps passam por Server Action ou Edge Function

### Erros e loading
- Páginas usam `loading.tsx` e `error.tsx` do App Router
- Mutations mostram estado de loading via `isPending` do TanStack Query ou `useFormStatus`
- Erros de validação da deps ou do Supabase são tratados e exibidos com mensagem legível — nunca expor stack trace ao usuário
