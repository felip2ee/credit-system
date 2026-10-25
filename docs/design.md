# Guia do design system Rainha Cred

Este guia diz como a interface é construída. Produto e escopo: [PRODUCT.md](../PRODUCT.md). Decisões e motivos: `docs/superpowers/specs/2026-10-24-design-system-rainha-cred-design.md`.

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

- Verde da marca `#009C97`: logo, ícones, destaques e texto grande. Não use em texto comum nem como fundo de botão com texto branco.
- Primário `#007A76`: texto, botões e anel de foco (contraste medido, acima de 4,5:1).
- Creme `#FCEDCE` (destaque) e escuro `#122C2B` (texto e barra lateral).
- Texto comum: no mínimo 4,5:1. Texto do portal sobre o fundo principal: no mínimo 7:1. Texto grande, ícones, bordas de controles e anel de foco: no mínimo 3:1.
- Bordas de controles usam `--border` e `--input` (`#7D9291`, acima de 3:1).
- Foco visível: contorno de 3 px com `--ring`, em todos os elementos.

## Tipografia e toque

- Fonte: **Atkinson Hyperlegible** (400 e 700), carregada com `next/font/google` em `src/app/layout.tsx` (variável `--font-sans`). No PDF, TTF do repositório.
- Base de 18 px no portal e nas páginas públicas (`.area-portal`), 16 px nos painéis. Nunca menos de 14 px; no portal nunca menos de 16 px. Altura de linha 1,5.
- Alvos de toque: 48 px no portal e nas páginas públicas, 44 px nos painéis. 8 px entre alvos.
- Botão só com ícone leva `aria-label`. Ícone importante tem texto ao lado.

## Estados

Seis tons em `StateTone`, sempre com **ícone + cor + texto**. Nunca só cor.

| Tom | Uso | Ícone |
|---|---|---|
| `success` | Deu certo | `CheckCircle2` |
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

- Ação e formulário: `Button`, `Input`, `Textarea`, `Label`, `Checkbox`, `RadioGroup`, `Select`, `Dialog`.
- Estado: `StatusBadge`, `StatusBanner`, `EmptyState`, `Skeleton`, `Stepper`, toast (`Toaster`, `role="status"`).
- Telas de sistema: `LoadingScreen`, `ErrorScreen`, e `loading.tsx`, `error.tsx`, `not-found.tsx`, `global-error.tsx` em `src/app/`.
- Layout: `PageHeader` (quebra linha no celular), `MobileNav` (gaveta "Menu" nos painéis, em `src/components/layout/`), `BottomNav` e `PortalHeader` (portal, em `src/components/portal/`).
- Dados: `Table`, `Card`, `Badge`.

Regras:
- Arquivo em kebab-case, um componente exportado por arquivo, `"use client"` só com hooks ou handlers.
- Um Server Component não passa função ou componente (ex.: ícone) como prop a um Client Component. Passe uma chave (ver `PortalNavIcon`).
- Tamanho `sm` de `Button` não vale no portal.
- Dependência nova só da família Radix.

## Layouts

- **Portal (celular):** cabeçalho com símbolo, "Rainha Cred" e saldo (só com `credits:read` e carteira; sem saldo, o cabeçalho não mostra nada). Barra inferior com ícone e texto: Início, Pesquisas, Créditos (com `credits:read`) e Conta. No computador, logo completa e os mesmos itens em linha.
- **Páginas públicas:** logo completa no topo, nome do Bureau, uma coluna.
- **Painéis (Bureau e superadmin):** barra lateral no computador. No celular, cabeçalho com botão "Menu" que abre a gaveta. A primeira tela vira cartões empilhados.
- Filtros guardam o estado na URL.

## Regras da marca

- Kit em `public/brand/rainha-cred/`. Não redesenhe, não mude as cores, não estique e não crie versão horizontal, branca ou preta (veja `LEIA-ME.txt`).
- PDF: cabeçalho e rodapé em código, com o nome do Bureau, e-mail de suporte e "Página X de Y". Sem Instagram e sem telefone.
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
