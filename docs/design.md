# Guia do design system Rainha Cred

Este guia diz como a interface é construída. Produto e escopo: [PRODUCT.md](../PRODUCT.md). Decisões e motivos: `docs/superpowers/specs/2026-10-24-design-system-rainha-cred-design.md` e o addendum `...-picpay-addendum.md` (linguagem visual vigente: formas e componentes do PicPay, com a marca Rainha Cred; sem logo nem verde do PicPay).

## Público e regras gerais

- Público: clientes PF/PJ (celular, muitos com idade mais alta) e equipe de Bureaus e superadmin (computador, tudo funciona no celular).
- Mobile first para o cliente (portal e páginas públicas).
- Texto de interface, erros e comentários em pt-BR, em linguagem simples e frases curtas. Identificadores em inglês.
- Uma marca: **Rainha Cred**. Sem white-label. Sem modo escuro.
- Exceção de nome: a razão social e o CNPJ ficam em `src/lib/scr/consent-term.ts` e nos textos legais.

## Fonte de verdade

| O quê | Onde |
|---|---|
| Cores e variáveis CSS | `src/app/globals.css` (valores HSL, hex nos comentários) |
| Cores em código (PDF, e-mail, estados) | `src/lib/brand/tokens.ts` |
| Nome da marca | `src/lib/brand/brand.ts` |
| Cálculo de contraste | `src/lib/brand/contrast.ts` (teste em `contrast.test.ts`) |
| Mapeamento Tailwind | `tailwind.config.ts` |
| Vocabulário de status | `src/lib/ui/status.ts` |
| Mensagem de falha | `src/lib/ui/failure-message.ts` |
| Kit da marca | `public/brand/rainha-cred/` |

Não copie valores de cor para outros arquivos. Importe do módulo de tokens.

## Cores e contraste

- Fundo da página `#FBF8F2`. Cartões são brancos. `--surface` (`#F7F2E8`) alterna seções em vez de sombra. `--muted` (`#F1ECE1`) para tile e linha cinza.
- Texto principal (ink) `#123029`. Texto secundário `#33514A` (7,8:1 sobre `--surface`).
- Primário `#0A3329` (verde-escuro): texto de destaque, links, anel de foco e cartão de saldo. Anel de foco: contorno de 3 px com `--ring` (`#0A3329`), em todos os elementos.
- Um só verde: `#0A3329` (`--primary`). Sucesso, ícones, barras e check usam esse verde. O extrato usa tags de entrada, gasto e cancelado (abaixo).
- Extrato: o valor vai em tag (`MoneyTag`), sempre com sinal (+/−); o ícone da linha tem a cor do texto da tag. Recarga e outras entradas: verde claro `--money-in-bg` `#E3EFE9` com texto `#0A3329`. Gasto: vermelho claro `--money-out-bg` `#FBE4E1` com texto `#8A1C14`. Cancelado ou sem efeito no saldo: cinza `--money-void-bg` `#EEEDEA` com texto `#4B5563`; cobrança cancelada ou vencida fica riscada. Vale no portal (`ClientStatement`) e na carteira do Bureau (`LedgerTable`).
- Cartão de saldo: fundo `--primary` com texto branco em negrito (13,8:1).
- Botão de ação principal (CTA): fundo creme `--brand-cream` `#F4EAD7` com borda dourada clara `--brand-gold-light` `#E6C891` e texto `--cta-foreground` `#2A1F0A` em negrito. Hover: fundo `#E6C891` (10:1). Mesmo estilo dos botões da Conta no portal.
- Dourado não serve para texto sobre fundo claro (contraste baixo, cerca de 2,1:1 sobre `#FBF8F2`). Para texto, use verde-escuro. O dourado é texto só sobre verde profundo.
- Verde profundo da marca `#05261F` (`--brand-deep`, `--sidebar`): barra lateral, faixas de topo (hero) e faixa final das páginas públicas. Texto creme `#F4EAD7` (13,5:1) e dourado `#CFA968` (7,3:1) sobre ele.
- Creme `#F4EAD7` (`--brand-cream`, `--secondary`, `--accent`, `--brand-soft`): destaques suaves. Tag positiva e item ativo usam `--brand-soft` com texto `#05261F` (13,5:1).
- Texto comum: no mínimo 4,5:1. Texto do portal sobre o fundo principal: no mínimo 7:1. Texto grande, ícones, bordas de controles e anel de foco: no mínimo 3:1.
- Bordas de controles usam `--input` (`#7F8F86`, 3,2:1). Borda de cartão plano usa `--border` (`#E3DCCD`, decorativa): nunca em campo ou controle.
- Sem degradê em nenhuma tela. A dona da marca rejeitou o degradê. Use cor sólida.
- Tokens da identidade: `--cta`, `--cta-foreground`, `--cta-hover`, `--brand-deep`, `--brand-gold`, `--brand-gold-light` e `--brand-cream`.
- PDFs e e-mails usam `BRAND_COLORS` de `tokens.ts`. Os modelos de e-mail no banco são recoloridos por migration. Não recolora modelo à mão.
- Neutros: `NEUTRAL_COLORS` em `tokens.ts` (50 a 900, escala `gray` do Tailwind). `500` para texto secundário (4,8:1). `400` só para placeholder ou ícone inativo decorativo, nunca texto de leitura.

## Painel do Bureau e Superadmin (`.theme-admin`)

- Só essas duas áreas têm página clara (`#F7F9F8`, texto `#05261F`). Portal, auth e landing ficam escuros.
- **Cartão padrão é branco.** `.theme-admin` em `src/app/globals.css` define `--card` `#FFFFFF`, borda `#D5E3DC` (decorativa), texto verde escuro, quadradinho de ícone `#E3EFE9` (`bg-brand-soft`). Campo e botão de contorno usam `--input` `#4A7C69` (4,8:1).
- **Destaque escuro** (`#0B3A2E`): `<Card variant="dark">` ou a classe `card-dark`, `<BalanceCard tone="dark">`. Use no hero e no máximo em um segundo destaque por tela. Menu lateral (`bg-sidebar` `#05261F`), `bg-ink`, `bg-secondary` e `on-dark` também re-declaram as variáveis escuras. Não use `bg-background` para fazer bloco.
- **Amarelo `#FFC400`** só em botão primário, estado ativo (menu, segmented, pílula), barra de gráfico com contorno e pequeno selo. Como texto ou borda sobre branco, `text-primary` e `border-primary` viram verde escuro (variável `--link`); amarelo como texto só dentro de destaque escuro.
- **Escala compacta, só no admin.** Variante Tailwind `admin:` (plugin em `tailwind.config.ts`, seletor `.theme-admin &`). O portal não muda. Título de página 24 px, subtítulo 14 px, corpo 14 px, rótulo 12 a 13 px. Hero com número serifado de 32 px; demais números de 24 px. Cartão com raio 18 px, padding 16 a 20 px, gap 12 px entre cartões, 20 a 24 px entre seções. Botão `h-10` (40 px, `sm` `h-9`), campo `h-10`, linha de tabela `py-2.5`, ícone em quadradinho de 36 px. Alvo mínimo de 36 px.
- **Densidade do portal logado.** Variante Tailwind `dense:` (plugin ao lado do `admin:`, seletor `.portal-dense &`, em qualquer largura). Só o layout `(portal)` tem `.portal-dense`; login, landing e admin ficam fora. `Card` com padding 16 px, `Button` `h-11` (`lg` `h-12`, `icon` `h-11 w-11`), `Input` e `Select` `h-11`, espaço entre blocos de 16 px. Limite conhecido: diálogos e toasts do Radix renderizam em `body`, fora de `.portal-dense`, e ficam no tamanho normal.
- Menu lateral de 224 px (`w-56`): item `h-10`, texto 14 px, ícone 18 px, logo `h-10`. Item ativo amarelo com texto `#05261F`.
- **Filtro de período e abas:** `SegmentedNav` (`src/components/ui/segmented-nav.tsx`): contêiner pílula branco com borda, opção `h-9`, ativa amarela. Usado no Dashboard (período), na lista de pesquisas (tipo) e na lista de pagamentos no balcão (forma de pagamento). Cada opção é link; `current="page"` para abas.
- **Estados** (`StatusBadge`, `StatusBanner`, toast): `toneStyle` lê `--st-<tom>-bg|fg|border`. No admin são os tons claros de `STATE_COLORS`; fora dele, os escuros de `APP_STATE_COLORS`.
- **Gráficos:** no admin `--chart-1..5` são `#0B3A2E`, `#2F7A5F`, `#9A7200`, `#4A7C69`, `#3D5A50` (todos 3:1 ou mais no branco). Dentro de destaque escuro voltam ao amarelo, verde claro e branco. Barra amarela sobre branco leva contorno `border-chart-3`.
- Valores e contrastes: `ADMIN_COLORS` em `src/lib/brand/tokens.ts` e `src/lib/brand/contrast.test.ts`.

## Dois temas de cor: `atual` e `classico`

- `BRAND_THEME` (variável de servidor; `atual` é o padrão e vale para valor ausente ou inválido) vira o atributo `data-brand-theme` no `<html>` (`src/app/layout.tsx`, lido em runtime; função `resolveBrandTheme` em `src/lib/brand/theme.ts`). O tema só troca cores. Layout, tamanhos e componentes são os mesmos. Fontes: o app usa Atkinson Hyperlegible e Georgia nos dois temas, e a landing usa Fraunces e Inter nos dois; por isso nenhuma fonte troca.
- `atual`: verde escuro + amarelo forte. Tokens em `:root` e `.theme-admin` de `src/app/globals.css`; hex em `APP_COLORS`, `ADMIN_COLORS`, `APP_STATE_COLORS`.
- `classico`: creme `#FBF8F2`, cartões brancos, dourado `#CFA968` (só fundo de botão e destaque sobre verde escuro), verde profundo `#05261F` e `#0A3329`. Blocos `html[data-brand-theme="classico"]` no fim de `globals.css`; hex em `BRAND_COLORS` e `CLASSIC_COLORS` (`src/lib/brand/tokens.ts`). Os blocos escuros (`.card-dark`, `.bg-sidebar`, `.bg-ink`, `.on-dark`) e `.landing` têm bloco próprio no clássico.
- Cor nunca fica em hex dentro de componente: use classe de token (`bg-primary`, `text-muted-foreground`, `bg-chart-1`), `var(--st-<tom>-bg|fg|border)` ou `var(--landing-...)`. PDF e e-mail usam `BRAND_COLORS` e não mudam com o tema. Fora do tema: `src/app/global-error.tsx` (renderiza sem o CSS do app) e `manifest.ts` (`background_color`; o manifesto não vê o tema).
- Para acrescentar um token: declare-o em `:root`, no bloco escuro e em `.theme-admin` do tema atual, e declare o par no bloco `html[data-brand-theme="classico"]` (claro e escuro). Acrescente o hex a `CLASSIC_COLORS`, os pares de contraste a `src/lib/brand/contrast.test.ts` (AA 4,5:1 texto, 3:1 componente e foco) e rode `e2e/a11y.spec.ts` e `e2e/mobile.spec.ts` com `BRAND_THEME=classico`.

## Forma, camadas e espaço

- Raios: campo `rounded-input` 8, cartão `rounded-card`/`rounded-lg` 12, destaque `rounded-hero` 16, modal `rounded-modal` 24. Botão, tag, busca e item ativo da barra: `rounded-full`.
- Sombras leves: `shadow-sm` baixa, `shadow-md` média, `shadow-lg` alta (valores em `globals.css`). `shadow-glow` (brilho dourado) só no CTA principal.
- Espaço: 4, 8, 12, 16, 24, 32, 40, 48. Margem de tela `px-screen` (16 px abaixo de 375 px, 20 px acima).
- Números de saldo e extrato: classe `tabular-nums`. Pesos 400, 500 e 700.

## Tipografia e toque

- Títulos (h1 a h3) em **Georgia** (serifa), pela classe `font-heading`.
- Texto corrido: **Atkinson Hyperlegible** (400 e 700), carregada com `next/font/google` em `src/app/layout.tsx` (variável `--font-sans`). No PDF, TTF do repositório.
- Base de 18 px só nas páginas públicas e de auth (`.area-portal`); 16 px no portal logado (`.area-portal.portal-dense`, layout do portal) e nos painéis. Nunca menos de 14 px; no portal nunca menos de 16 px. Altura de linha 1,5.
- Alvos de toque: 48 px nas páginas públicas e de auth; 44 px no portal logado e nos painéis. 8 px entre alvos.
- Botão só com ícone leva `aria-label`. Ícone importante tem texto ao lado.

## Estados

Seis tons em `StateTone`, sempre com **ícone + cor + texto**. Nunca só cor.

| Tom | Uso | Ícone |
|---|---|---|
| `success` | Deu certo. Tag de sucesso: fundo verde claro `#E3EFE9`, texto e ícone verde `#0A3329`, borda sutil `#B9D3C6` (tag e banner) | `CheckCircle2` |
| `waiting` | Aguardando outra pessoa (titular, sócio, Bureau, pagamento) | `Clock` |
| `progress` | Em andamento (na fila, consultando) | `Loader2` |
| `attention` | Não foi possível (falha esperada e recuperável) | `AlertTriangle` |
| `danger` | Erro inesperado do sistema | `XCircle` |
| `neutral` | Informação, vazio, expirado, cancelado | `Info` |

`attention` e `danger` usam `role="alert"`; os outros usam `role="status"`. Leitores de tela anunciam o texto, não só o ícone.

## Vocabulário único

`statusInfo(domain, status, audience)` em `src/lib/ui/status.ts` devolve `{ tone, label, explanation, nextStep }`. Domínios: pedido, motivo do pedido, consulta, autorização SCR, membro, saque, comissão e lançamento de carteira.

- Toda tela usa esse módulo. Não escreva rótulo de status à mão.
- Status sem mapeamento mostra o estado de erro com texto genérico. Nunca mostra o código.
- Termos fixos: "Autorizado" (não "Concedida"), "Não foi possível consultar" (não "Erro" na consulta), "Pronto, aguardando liberação do Bureau" e "Pronto para ver".
- O termo "SCR" não muda.

## Mensagem de falha ao cliente

Três partes, nesta ordem, sem termo técnico e sem código de erro. Use `failureMessage()`.

1. **O que aconteceu.** "Não conseguimos consultar este CPF agora."
2. **O que aconteceu com o dinheiro.** "O valor voltou para o seu saldo." / "Nada foi cobrado." / "O valor continua reservado."
3. **O que fazer agora**, com um botão. "Tente de novo mais tarde." [Voltar para minhas pesquisas]

## Componentes

Primitivos em `src/components/ui/` (Radix + `cva` + `cn()`). Não crie botão, campo ou selo à mão.

- Ação: `Button` (pílula). `default` é creme com borda dourada clara e texto `--cta-foreground`; `cta` é dourado cheio (`--cta`, hover `--cta-hover`) só para as entradas "Nova pesquisa" e "Novo pedido"; `outline` é o secundário; `ghost` é o terciário (só texto); `dark` (`#123029`, `--ink`); `onBrand` (branco, sobre o cartão de saldo); `secondary`, `destructive`, `link`. Prop `glow` dá brilho dourado só ao `default` e ao `cta` e só no CTA principal da tela. `IconButton` é circular, 48 px em público e auth e 44 px no portal logado e nos painéis, e exige `aria-label`.
- Formulário: `Input`, `Textarea`, `Select` (8 px; 48 px de altura em público e auth, 44 px no portal e nos painéis; erro por `aria-invalid`), `Field` (rótulo sempre visível, ajuda e erro ligados por `aria-describedby`), `SearchInput` (pílula), `Label`, `Checkbox`, `RadioGroup`, `Dialog` (24 px, scrim escuro).
- Cartão: `Card` com `variant` `flat` (padrão, borda de 1 px), `elevated`, `hero` (amarelo do portal) e `dark` (verde escuro do painel admin).
- Cartões de produto mostram nome e descrição completos (sem corte); o bloco "O que você recebe" é um `<details>` com seta (chevron) que gira ao abrir.
- Saldo e atalhos: `BalanceCard` (valor grande com `tabular-nums`, `hideable` mostra o olho; `displayBalance` em `balance.ts`), `QuickActions` + `QuickAction` (tile de 56 px com ícone, rótulo embaixo, `active` para a ação principal, link ou botão), `ListRow` (ícone circular cinza, título, subtítulo, valor à direita), `SectionHeader` (título e link).
- Estado: `StatusBadge`, `Badge` (pílula; `variant="brand"` para tag positiva), `StatusBanner`, `EmptyState`, `Skeleton`, `Stepper` (círculos, "Agora:"), toast (`Toaster`, `role="status"`).
- Telas de sistema: `LoadingScreen`, `ErrorScreen`, e `loading.tsx`, `error.tsx`, `not-found.tsx`, `global-error.tsx` em `src/app/`.
- Layout: `PageHeader` (quebra linha no celular), `MobileNav` (gaveta "Menu" nos painéis, em `src/components/layout/`), `BottomNav` e `PortalHeader` (portal, em `src/components/portal/`).
- Dados: `Table`.

Regras:
- Arquivo em kebab-case, um componente exportado por arquivo, `"use client"` só com hooks ou handlers.
- Um Server Component não passa função ou componente (ex.: ícone) como prop a um Client Component. Passe uma chave (ver `PortalNavIcon`).
- Tamanho `sm` de `Button` não vale no portal.
- Dependência nova só da família Radix.

## Layouts

- **Portal (celular):** cabeçalho com a logo e o chip de saldo (só com `credits:read` e carteira; sem saldo, o cabeçalho não mostra nada). Barra inferior com ícone e texto; o item ativo é um círculo verde-escuro (`--primary`) com ícone branco e rótulo visível: Início, Pesquisas, Créditos (com `credits:read`) e Conta. No computador, logo completa e os mesmos itens em linha.
- **Saldo:** aparece só no chip do cabeçalho e na tela Créditos. Nenhuma outra tela repete o saldo.
- **Texto em lista:** corta com "…" (uma linha). Exceção: o nome do Bureau no `PublicShell` quebra em várias linhas.
- **Créditos:** o extrato fica agrupado por data. A tela não tem tabela de movimentos nem a seção "Recargas recentes".
- **Explicações:** Nova pesquisa tem a introdução "como funciona" (`ResearchIntro`). Afiliação tem "Como funciona" (`HowItWorks`). A página pública do Bureau tem a mesma explicação em `PublicHowItWorks`.
- **Páginas públicas:** logo completa no topo, nome do Bureau, uma coluna.
- **Painéis (Bureau e superadmin):** barra lateral no computador (verde profundo). No celular, cabeçalho com botão "Menu" que abre a gaveta. A primeira tela vira cartões empilhados.
- Filtros guardam o estado na URL.
- Resultado da pesquisa (cliente): a tela mostra o resumo (score, restrições) e o parecer de IA; o detalhe completo fica no PDF.

## Regras da marca

- Kit em `public/brand/rainha-cred/`. Não redesenhe, não mude as cores, não estique e não crie versão horizontal, branca ou preta (veja `LEIA-ME.txt`). Não recolora o kit.
- PDF: papel timbrado A4 (`public/brand/rainha-cred/timbrado/`) com logo em código e rodapé com e-mail de suporte, WhatsApp e Instagram (só os que existem) e "Página X de Y". Helvetica, corpo 10 pt, tabelas 9 pt; cores e medidas em `src/lib/pdf/theme.ts`. A consulta abre com identidade, resumo e score; o dossiê abre com uma capa que lista os membros, e cada membro começa em página nova. Da segunda página em diante, uma linha ao lado do logo diz de quem é o documento.
- E-mail: logo por URL absoluta, fonte `Arial, sans-serif`, rodapé com "Rainha Cred" e o suporte.
- E-mail de suporte: variável `SUPPORT_EMAIL` (padrão `suporte@rainhacred.com.br`; domínio a confirmar).
- Ícone do app, `manifest` e `metadata` usam o nome "Rainha Cred".

## Telas críticas do cliente

São a base dos testes de acessibilidade e de celular:

1. `/b/[slug]` (vitrine do Bureau)
2. `/b/[slug]/cadastro`
3. `/cadastro/confirmar-email`
4. `/login` e `/mfa/verify`
5. `/portal/termos`
6. `/portal` (início)
7. `/portal/pesquisas/nova`
8. `/portal/pesquisas`
9. `/portal/pesquisas/[id]`
10. `/autorizacao-scr/[token]` e `/portal/credits`

Primeiras telas dos painéis: `/` (Bureau) e `/superadmin`.

## Verificação

- `e2e/a11y.spec.ts`: axe (WCAG 2.1 A e AA) nas telas acima. Falha com violação de `color-contrast`, `label`, `button-name` ou `link-name`. As outras violações ficam no anexo `axe-violations.json` do teste.
- `e2e/mobile.spec.ts`: 360 × 740, sem rolagem horizontal (também com `html{font-size:200%}`), alvos de toque de pelo menos 44 × 44, e a gaveta "Menu" do Bureau.
- Exceções de alvo: link dentro de texto corrido; elemento de 1 px só para leitor de tela; campo oculto do Radix (`aria-hidden`); `Checkbox`, cuja área de 44 px vem do `::after`.
- Lista das telas: `e2e/critical-screens.ts`. Acrescente aqui toda tela nova crítica.
- Comandos: `npm run build`, depois `npm run test:e2e`. Detalhes de ambiente: `docs/quality.md` e README.

## Manutenção

Mudança visual atualiza o módulo de tokens, o componente e este guia na mesma tarefa. Mudança de rótulo ou de controle atualiza os e2e (`getByLabel`, `getByRole`, `getByText`).
