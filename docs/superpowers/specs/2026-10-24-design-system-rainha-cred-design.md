# Design system Rainha Cred — design

Data: 2026-10-24. Estado: pronto para revisão do dono (dúvidas do revisor resolvidas em 2026-10-24). Branch: `feature/design-system-rainha-cred` (a partir de `feature/ajuste-saldo-cliente`, que contém dossiês, afiliados e ajuste de saldo).

## Intenção

O sistema ainda não foi usado por clientes reais. O dono quer chegar ao primeiro uso com uma interface que **qualquer pessoa idosa entenda**: o que está acontecendo, o que deu certo, quando não foi possível consultar e o que fazer depois. A interface usa uma marca só, **Rainha Cred**, no app, nos PDFs e nos e-mails.

Sem dados de uso, as decisões seguem boas práticas para público mais velho e baixa familiaridade digital. Depois do primeiro uso real, o dono ajusta com base no que observar.

## Públicos e telas

- **Cliente final (portal e páginas públicas):** usa quase sempre o celular. É a prioridade: **mobile first**, a partir de 360 px de largura.
- **Equipe do Bureau e superadmin:** usam o computador, que é a melhor experiência para eles. **Todas** as telas funcionam no celular sem quebrar. A **primeira tela** de cada painel (resumo da operação) fica boa de ler no celular, para acompanhar sem operar.

## Metas

1. **Uma marca:** "Rainha Cred" substitui "Reino do Crédito", "Rainha do Crédito", "Beabá do Crédito" e "Eliane Moreira" em toda a interface, nos PDFs, nos e-mails, no nome do remetente SMTP, no emissor do MFA (TOTP) e nos textos do parecer IA. **Exceção (decisão do dono):** o termo de autorização SCR e os textos legais mantêm a razão social e o CNPJ de quem consulta (`authorizedName: "Eliane Moreira - Ordem Consultoria"`, CNPJ `12.296.230/0001-29`, em `src/lib/scr/consent-term.ts`); "Rainha Cred" aparece só como marca no visual dessas páginas.
2. **Identidade visual:** logo, símbolo e ícones do kit oficial, cores da marca e tipografia legível.
3. **Estados claros:** um sistema único de estados (carregando, deu certo, aguardando outra pessoa, em andamento, não foi possível, erro, vazio), igual em todas as telas, com ícone, cor e texto juntos.
4. **Mensagens que orientam:** toda falha diz o que aconteceu, o que aconteceu com o dinheiro e o que a pessoa faz agora.
5. **Celular:** o portal funciona com uma mão no celular; os painéis do Bureau e do superadmin ganham menu no celular e primeira tela legível.
6. **PDF:** cabeçalho e rodapé montados em código com a identidade Rainha Cred, sem a imagem de fundo `public/letterhead.png`.
7. **E-mails:** modelos com a identidade Rainha Cred.

## Não metas

- White-label por Bureau (cores ou logo do Bureau). O Bureau aparece só pelo nome.
- Modo escuro. Os tokens `.dark` atuais podem sair se ficarem órfãos.
- Redesenhar a logo, criar versão horizontal, branca ou preta, recolorir ou esticar (regras do kit, `public/brand/rainha-cred/LEIA-ME.txt`).
- Mudar regras de negócio, fluxos ou textos jurídicos além da troca do nome da marca.
- Aplicativo nativo. "Ícone do app" = favicon e manifest da web.

## Antimetas (falha mesmo se funcionar)

- Um estado que só se distingue pela cor.
- Texto de leitura com contraste abaixo de 4,5:1, ou texto do portal menor que 16 px.
- Uma falha que não diz se o cliente perdeu dinheiro.
- Um termo técnico ou código de erro na frente do cliente ("payload", "DEPS", "500", "deps_unavailable").
- Uma tela do portal que exige rolagem horizontal em 360 px, ou um alvo de toque menor que 44 × 44 px.
- A mesma situação com nomes diferentes em telas diferentes.

## Marca

Fonte: kit oficial, já copiado para `public/brand/rainha-cred/` (o kit original foi apagado; o `LEIA-ME.txt` cita WebP e pastas que não foram copiados — ignore):
- `logo/rainha-cred-logo-completa-transparente.svg` e `.png` (2048 px de largura), `logo/…-fundo-escuro.svg`, `logo/…-fundo-creme.svg`.
- `simbolo/rainha-cred-simbolo-original-transparente.svg` e `.png` (o C coroado).
- `icones/favicon.ico`, `icones/icone-transparente.svg`, `icones/icone-fundo-branco-{180,192,512}.png`, `icones/icone-fundo-creme-512.png`.
- `LEIA-ME.txt`: regras de uso.

Uso:
- Logo completa: login, cadastro, cabeçalho do portal no computador, PDF, e-mail.
- Símbolo: cabeçalho do portal no celular, sidebar recolhida, favicon e ícone do app.
- Sempre proporcional (`object-fit: contain`, largura e altura proporcionais). Nunca sobre fundo que reduza a legibilidade da marca.

Cores do kit:
- **Verde da marca:** `#009C97`.
- **Creme:** `#FCEDCE`.
- **Escuro:** `#122C2B`.

## Fundamentos (tokens)

Requisitos (os valores exatos ficam com o builder, salvo os da marca):
- **Contraste:** texto de leitura ≥ 4,5:1 (meta 7:1 no portal); texto grande (≥ 24 px, ou ≥ 19 px em negrito), ícones e bordas de controles ≥ 3:1. Medir com ferramenta, não estimar.
- **Verde da marca `#009C97`** tem cerca de 3,4:1 sobre branco: serve para logo, ícones, destaques e texto grande, **não** para texto comum nem para botão com texto branco. Criar um tom mais escuro do mesmo verde para botões primários, links e texto (referência: `#007A76` dá cerca de 5,2:1 com branco — confirmar na medição).
- **Texto principal:** `#122C2B` ou próximo.
- **Superfícies:** branco e creme `#FCEDCE` para áreas de destaque (não para blocos de texto longo).
- **Cores de estado** próprias (verde de sucesso diferente do verde da marca, âmbar, vermelho, azul de espera, cinza), cada uma com fundo claro e texto escuro que passem no contraste.
- **Foco visível:** anel de 2 px com ≥ 3:1 sobre o fundo, em todo elemento interativo (o anel dourado atual tem contraste baixo).
- **Tipografia (decisão do designer):** **Atkinson Hyperlegible** (fonte aberta feita para baixa visão) via `next/font/google` na web e o mesmo arquivo TTF no PDF. Tamanho base: **18 px no portal e nas páginas públicas**, 16 px nos painéis. Nada abaixo de 14 px em lugar nenhum; no portal, nada abaixo de 16 px. Linha 1,5.
- **Toque:** botões e campos com altura mínima de 48 px no portal e 44 px nos painéis; espaço de 8 px entre alvos.
- **Movimento:** respeitar `prefers-reduced-motion`; nada piscando.
- Os tokens vivem em `src/app/globals.css` (variáveis CSS) e `tailwind.config.ts`, como hoje. O PDF e os e-mails usam as mesmas cores, a partir de um módulo único de tokens em TS (ex.: `src/lib/brand/tokens.ts`).

## Telas críticas do cliente (base dos testes de celular e de contraste)

1. `/b/[slug]` (vitrine do Bureau)
2. `/b/[slug]/cadastro`
3. `/cadastro/confirmar-email`
4. `/login` e `/mfa`
5. `/portal/termos`
6. `/portal` (início)
7. `/portal/pesquisas/nova` (novo pedido)
8. `/portal/pesquisas` (lista)
9. `/portal/pesquisas/[id]` (andamento, aceites, entrega, PDF)
10. `/autorizacao-scr/[token]` (titular, sem login) e `/portal/credits` (recarga PIX)

Primeiras telas dos painéis: `(dashboard)/page.tsx` e `superadmin/page.tsx`.

## Sistema de estados

Sete estados, sempre com **ícone + cor + texto** (nunca só cor) e sempre os mesmos:

| Estado | Quando | Tom | Ícone (lucide, sugestão) |
|---|---|---|---|
| Carregando | esperando a tela ou uma ação | neutro | spinner/esqueleto |
| Deu certo | ação concluída, resultado pronto | sucesso (verde) | `CheckCircle2` |
| Aguardando outra pessoa | depende do titular, de um sócio, do Bureau ou de pagamento | espera (azul) | `Clock` / `UserRoundCheck` |
| Em andamento | o sistema está trabalhando (na fila, consultando) | informação (verde da marca, distinto do verde de sucesso por ícone e texto) | `Loader` |
| Não foi possível | falha esperada e recuperável (sem dados na base, serviço fora do ar, autorização recusada ou vencida, saldo insuficiente) | atenção (âmbar) | `AlertTriangle` |
| Erro | falha inesperada do sistema | perigo (vermelho) | `XCircle` |
| Vazio | ainda não há nada | neutro | ícone ilustrativo + ação |

**Padrão de mensagem de falha** (obrigatório, em linguagem simples, frases curtas):
1. **O que aconteceu.** "Não conseguimos consultar este CPF agora."
2. **E o dinheiro.** "O valor voltou para o seu saldo." / "Nada foi cobrado." / "O valor continua reservado."
3. **O que fazer agora**, com um botão. "Tente de novo mais tarde." [Voltar para minhas pesquisas]

**Vocabulário único.** O builder cria um módulo único (ex.: `src/lib/ui/status.ts`) que mapeia cada status do sistema para `{ estado, rótulo, explicação curta, próximo passo }` e todas as telas usam esse módulo. Conflitos atuais a resolver (levantamento de 2026-10-24):
- Pedido "Concluída" (pronto, falta o Bureau liberar) vs "Liberada": para o cliente, "Pronto, aguardando liberação do Bureau" e "Pronto para ver".
- Consulta "Erro" vs pedido "Não concluída": unificar como **"Não foi possível consultar"**, com o motivo em linguagem simples ("Não encontramos dados para este documento", "O serviço de consulta está fora do ar").
- "Autorizada" / "Concedida" / "autorização concedida": unificar como **"Autorizado"**.
- Esperas por terceiros (titular, sócio, Bureau, pagamento) separadas das esperas internas (na fila, consultando).
- "Expirada" e "Cancelada" com contraste e ícone próprios (hoje cinza sobre cinza).
- Inventário de partida: `src/lib/orders/labels.ts`, `src/types/app.ts:100-115`, `src/components/affiliates/affiliate-rules.ts`, `src/components/affiliates/withdrawal-queue-rules.ts`, `src/components/credits/client-ledger-labels.ts`, `src/components/wallet/LedgerTable.tsx`, badges `QueryStatusBadge`, `ScrStatusBadge`, `OrderStateBadge`, membros do pedido (`order-members.tsx`).

**Telas de sistema** por segmento: `loading.tsx` (esqueleto), `error.tsx` (estado Erro com "Tentar de novo" e "Voltar"), `not-found.tsx` e `global-error.tsx`, no padrão acima.

**Avisos de ação** (salvou, copiou, enviou): um componente de aviso (toast) acessível (`role="status"`, some sozinho em ≥ 6 s, pode ser fechado), mais o texto fixo na própria tela quando a ação é importante (pagamento, pedido, saque).

## Componentes

Base atual: shadcn/ui com 7 componentes (`badge`, `button`, `card`, `dialog`, `input`, `label`, `table`). Faltam e devem existir, com os tokens acima:
- `StatusBadge` e `StatusBanner` (alerta) ligados ao sistema de estados.
- `EmptyState`, `Skeleton`, aviso (toast).
- `Textarea`, `Select`, `RadioGroup`, `Checkbox` (hoje há 5 `<textarea>`, 11 `<select>` e radios crus).
- `Stepper` de progresso do pedido para o cliente (ex.: Pedido feito → Autorizações → Consultando → Pronto), com o passo atual destacado e texto.
- Tamanhos de `Button` e `Input` atualizados para os mínimos de toque; o tamanho `sm` some no portal.
- Ícone sempre com texto ao lado nos controles importantes; botão só com ícone tem `aria-label`.
Dependências novas só se necessárias e da mesma família (Radix, que o projeto já usa).

## Layouts

- **Portal (celular):** cabeçalho com o símbolo, o nome "Rainha Cred" e o saldo de créditos (só para quem tem `credits:read`; o layout passa a buscar o saldo). Navegação principal por **barra inferior** com ícone e texto **(decisão do designer)**: **Início**, **Pesquisas**, **Créditos** (só com `credits:read`) e **Conta** (perfil, Afiliação quando houver `affiliates:read`, termos e **Sair**). Afiliação também aparece como cartão na Início para quem tem a permissão. No computador, cabeçalho com a logo completa e os mesmos itens em linha. Uma ação principal por tela, grande e fixa no fim da tela quando fizer sentido (ex.: "Confirmar pedido").
- **Páginas públicas** (`/b/[slug]`, cadastro, confirmação de e-mail, autorização SCR do titular, termos): logo completa no topo, nome do Bureau, conteúdo em uma coluna.
- **Painel do Bureau e superadmin:** sidebar no computador como hoje, com a logo; no celular, cabeçalho com o símbolo e um **menu em gaveta** (hoje não existe navegação no celular). A primeira tela de cada painel vira cartões empilhados no celular (números grandes, um por cartão). `PageHeader` quebra linha no celular.
- `SupportBanner` (modo suporte) usa o estado Atenção.

## PDF

Hoje: `public/letterhead.png` (timbrado "Eliane Moreira · Rainha do Crédito", chave e moeda douradas, telefone, e-mail e Instagram) como imagem de fundo em A4, Helvetica 7–7,5 pt, cores locais. Documentos: `src/lib/pdf/consultation-document.tsx`, `consultation-full-document.tsx`, `complete-consultation-document.tsx`, `dossier-document.tsx`, `markdown-pdf.tsx`; imagem lida em `src/lib/pdf/letterhead.ts`; rotas em `consultations/[id]/pdf`, `dossiers/[id]/pdf`, `portal/pesquisas/[id]/pdf`.

Novo (decisões do dono):
- **Cabeçalho** em código, repetido em toda página (`fixed`): logo completa Rainha Cred à esquerda; à direita, o **nome do Bureau** que vendeu e a data de emissão.
- **Rodapé** em código, em toda página: `suporte@rainhacred…` (veja "Pendências") e "Página X de Y". Sem Instagram, sem telefone.
- Sem a imagem de fundo: `public/letterhead.png` e `letterhead.ts` saem quando ficarem órfãos.
- Fonte Atkinson Hyperlegible registrada (`Font.register`, arquivo TTF no repositório); corpo ≥ 10 pt, tabelas ≥ 9 pt; cores do módulo de tokens.
- Estados no PDF (risco, sem dados, não foi possível) com texto e ícone ou marcador, nunca só cor.
- O nome do Bureau vem do `bureau_id` da consulta ou do dossiê (sempre preenchido: toda consulta pertence a um Bureau). Hoje nenhum documento PDF recebe esse nome: as 3 rotas passam a buscar o nome do Bureau e os 5 documentos recebem `bureauName` como prop.

## E-mails

Os modelos ficam no banco (migrations 020 a 022, tabela `notification_templates`, imutável: ativo → aposentado). Uma **migration nova** insere a versão nova de cada modelo da plataforma e aposenta a versão semeada anterior; um modelo personalizado (que não é a versão semeada) não é tocado. O sistema ainda não teve uso real. Não editar migration aplicada.
- Cabeçalho com a logo completa (PNG por URL absoluta: `BETTER_AUTH_URL` + `/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.png`), cores dos tokens, fonte com fallback seguro para e-mail (Atkinson não carrega em todos os clientes: `Arial, sans-serif`).
- Rodapé com "Rainha Cred" e o e-mail de suporte; sem telefone e sem Instagram.
- Mesmo padrão de mensagem de falha do app.
- Remetente SMTP com o nome "Rainha Cred".

## Ícone do app e metadados

- `src/app/favicon.ico` → o do kit; `icon` e `apple-icon` com os PNG do kit; `manifest` com nome "Rainha Cred", ícones 192 e 512, cor de tema.
- `metadata`: título "Rainha Cred" (com o nome da página), descrição, `themeColor`, `viewport` adequado.

## Restrições

- Next.js 14 App Router, Tailwind, shadcn/ui, lucide, `@react-pdf/renderer`; sem biblioteca de UI nova fora da família Radix.
- Textos em pt-BR, linguagem simples; regras do `AGENTS.md`.
- Os testes e2e (`e2e/*.spec.ts`, `e2e/fixtures.ts`) selecionam por rótulo e texto (`getByLabel`, `getByRole`, `getByText`). Toda troca de rótulo, de texto de sucesso ou de controle (ex.: `<select>` → `Select`) atualiza os e2e na mesma tarefa.
- Testes que fixam texto: `src/lib/notifications/render.test.ts:41`, `notifications.integration.test.ts:1304-1315`, `src/lib/config.test.ts:131`, `src/lib/email/mailer.test.ts`.
- O termo de consentimento SCR (`src/lib/scr/consent-term.ts`) **não muda**: razão social e CNPJ ficam (documento do Bacen; o `fullText` é gravado como prova). Só o visual da página `/autorizacao-scr/[token]` ganha a marca.
- `docs/design.md` vira o guia do design system (tokens, estados, vocabulário, componentes, regras da marca).

## Decidido pelo dono

- Público mais velho, sem dados de uso: seguir boas práticas e ajustar depois.
- Mobile first para o cliente; Bureau e superadmin usam o computador, tudo funciona no celular e a primeira tela dos painéis fica boa no celular.
- Uma marca só: **Rainha Cred**, em tudo.
- PDF: cabeçalho e rodapé com a identidade, nome do Bureau, e-mail de suporte; sem Instagram e sem telefone.
- Kit em `public/brand/rainha-cred/`; o kit original foi apagado.
- O termo SCR e os textos legais mantêm a razão social e o CNPJ.

## Decisões do designer (o dono pode corrigir)

- Tipografia Atkinson Hyperlegible, 18 px no portal e 16 px nos painéis.
- Tom de verde mais escuro para texto e botões; verde original para logo e destaques.
- Barra de navegação inferior no portal; gaveta nos painéis no celular.
- Sete estados com ícone, cor e texto; módulo único de vocabulário.
- Sem modo escuro.

## Pendências

- **E-mail de suporte:** o dono disse "suporte@rainhacred". O domínio não foi confirmado. Usar uma variável de configuração `SUPPORT_EMAIL` com padrão `suporte@rainhacred.com.br` (confirmar o domínio antes do deploy).

## Critérios de aceitação

- [ ] Nenhuma ocorrência de "Reino do Crédito", "Rainha do Crédito", "Beabá do Crédito" ou "Eliane Moreira" na interface, PDFs, e-mails, remetente e emissor do MFA (grep no `src/` e nos modelos de e-mail vigentes), **exceto** a razão social em `src/lib/scr/consent-term.ts` e nos textos legais.
- [ ] Teste: o módulo de vocabulário cobre todos os status de pedido, consulta, autorização SCR, membro, saque e lançamento de carteira, e cada um tem estado, rótulo e próximo passo.
- [ ] Teste: as mensagens de falha do cliente seguem o padrão (o que aconteceu, dinheiro, o que fazer).
- [ ] Contraste medido (ferramenta automatizada, ex. axe no Playwright) sem violação AA nas 10 telas críticas do cliente e nas primeiras telas dos painéis.
- [ ] As 10 telas críticas do cliente sem rolagem horizontal em 360 px e com alvos ≥ 44 px (verificação no Playwright em 360 × 740).
- [ ] Painel do Bureau e do superadmin com navegação no celular.
- [ ] PDF sem `letterhead.png`, com cabeçalho e rodapé novos, nome do Bureau, e-mail de suporte, "Página X de Y" e corpo ≥ 10 pt (teste de geração).
- [ ] E-mails com a identidade nova via migration nova (teste do render).
- [ ] Favicon, ícones e manifest do kit.
- [ ] `npm run check` e e2e verdes.
- [ ] (post-deploy) Primeiras sessões reais de clientes idosos observadas; ajustes registrados.
