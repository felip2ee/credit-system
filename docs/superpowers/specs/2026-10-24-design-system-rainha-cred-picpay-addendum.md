# Addendum — linguagem visual PicPay no design system Rainha Cred

Data: 2026-10-24. Origem: o dono não gostou do visual da primeira entrega ("meio feio") e pediu o design system do PicPay (https://designmd.app.br/brands/picpay/) com imagens de referência (app de finanças: cartão de saldo verde, grade de ações rápidas, cartões planos, barra inferior com item ativo circular).

Este addendum **altera só a forma visual**. A spec `2026-10-24-design-system-rainha-cred-design.md` continua valendo em tudo o que não for contrariado aqui (marca única, acessibilidade para público mais velho, estados, mensagens de falha, PDF, e-mail, sem regra de negócio nova).

## Decisão (ruling)

- Usamos o **sistema** do PicPay (formas, camadas, componentes, padrões de tela). **Não** usamos a identidade do PicPay: logo, nome e verde `#21C25E` não entram. A marca continua Rainha Cred: verde-azulado `#009C97` (destaque), tom escuro `#007A76`/similar para texto e botões (contraste), creme `#FCEDCE`, escuro `#122C2B`. Custo se errado: recolorir por tokens (1 arquivo).
- Acessibilidade vence o PicPay onde conflitar: base 18 px no portal, texto ≥ 4,5:1 (portal 7:1), alvos ≥ 48 px no portal, Atkinson Hyperlegible, sem texto só em cor.

## Tokens do PicPay a adotar

- Raios: input 8, cartão 12, cartão destaque/bottom sheet 16, modal 24, **botões, chips, busca e ações rápidas em pílula (999)**, avatar/ícone circular.
- Sombras leves: baixa `0 1px 3px rgba(0,0,0,.06)`, média `0 4px 12px rgba(0,0,0,.08)`, alta `0 8px 24px rgba(0,0,0,.12)`. Nada de sombra pesada. Cartão plano = borda 1 px `#E5E7EB`.
- Fundos: branco e cinza `#F5F7FA` alternados (em vez de sombra); seção escura só para destaque.
- Neutros: 50 `#F9FAFB` … 900 `#111827`; texto secundário `#6B7280` (só se passar 4,5:1 no fundo usado), terciário `#9CA3AF` só para placeholder/inativo (nunca texto de leitura).
- Espaçamento: 4, 8, 12, 16, 24, 32, 40, 48. Margem de tela 20 px (≥ 375 px), 16 px (< 375 px); gutter 16 px.
- Tipografia: pesos 400/500/700 (máx. 3 por tela); hierarquia Display 700, Título 600→700, Subtítulo 500, Corpo 400; números de saldo e extrato com `tabular-nums`. Linha 1,4–1,6.
- Ícones: contorno (lucide), traço 2 px, 24 px base, alvo ≥ 44 px; ativo na cor da marca, inativo cinza com contraste ≥ 3:1. Nunca misturar preenchido e contorno na mesma superfície.

## Componentes e padrões

- Botão primário pílula (fundo verde escuro da marca, texto branco em negrito), secundário contorno, terciário só texto, escuro `#122C2B`; brilho verde só no CTA principal da tela. IconButton circular 48 px.
- Campo com rótulo (flutuante ou fixo acima, sempre visível), texto de ajuda e estado de erro; busca em pílula.
- Cartão de saldo ("balance hero") em verde da marca com texto branco em negrito (≥ 4,5:1; se o verde da marca não passar, usar o tom escuro), botão "ver extrato"/ação em pílula branca; olho para ocultar/mostrar saldo.
- Grade de **ações rápidas**: quadrados/círculos com ícone e rótulo embaixo, item principal em verde.
- Lista de lançamentos/transações: ícone circular cinza, título, subtítulo, valor à direita com `tabular-nums`; grupo por data.
- Tag/badge: pílula pequena (verde claro `#E6F9ED`-equivalente da marca para positivo); estados continuam ícone + cor + texto.
- Barra inferior: 4–5 itens, ícone + rótulo; item ativo em círculo verde com ícone branco e rótulo. Cabeçalho do app: avatar/símbolo, busca opcional, saldo com olho, notificações.
- Painéis (Bureau/superadmin): mesma linguagem (cartões planos, pílulas, cinza alternado), densidade maior no computador.
- Telas de acompanhamento (pedido): etapas verticais com círculo, como no padrão de "central de segurança" (cartão com nível, lista de itens com tag "Ativo").

## Referência de login e entrada (imagem 6 do dono)

Arquivo de referência: `/private/tmp/claude-501/-Users-felipeborges-Documents-projetos-Eliane-Moreira-credit-system/0927bd3d-9f9e-44e9-97de-b5f7690af81a/images/6.jpg` (kit "Banking Mobile App UI Kit").

Padrão a seguir nas telas `/login`, `/mfa`, `/b/[slug]`, cadastro e redefinição de senha:
- Fundo claro e limpo, conteúdo em uma coluna centralizada, muito espaço; logo completa no topo; título grande e curto + uma linha de apoio.
- Campos grandes com ícone à esquerda (usuário/e-mail, cadeado) e botão de mostrar/ocultar senha à direita (olho, com `aria-label`); o rótulo continua visível acima do campo (não só placeholder).
- Botão principal em pílula, largura total no celular, texto em negrito; link "Esqueci a senha" e "Criar conta" como texto de apoio com alvo ≥ 48 px.
- Entrada rápida opcional (biometria/código) só se já existir no produto; não inventar fluxo novo.
- Cor: marca Rainha Cred (verde-azulado), não o azul da imagem; o azul da referência vale só como inspiração de layout e suavidade (cantos bem arredondados, sombra leve).
