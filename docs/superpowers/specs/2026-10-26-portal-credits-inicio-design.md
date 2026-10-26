# Portal: saldo só em Créditos, Início enxuta, textos que cortam

Data: 2026-10-26. Branch: `feature/design-system-rainha-cred`. Só interface. Sem mudança de banco nem de regra de negócio.

## Intenção

O bloco verde de saldo na Início repete a tela Créditos. O cabeçalho quebra linha ("Saldo" + valor + "Rainha Cred"). Textos longos quebram em várias linhas e a tela fica grande. O cliente não sabe o que é uma pesquisa nem como a afiliação funciona.

## Metas

- Saldo e Recarregar existem só em Créditos (`/portal/credits`).
- Cabeçalho do portal: só o valor do saldo, à direita, com olho para esconder. Sem "Rainha Cred" e sem rótulo "Saldo". Toque leva a Créditos. Sem `credits:read`, o cabeçalho não mostra saldo (regra atual).
- Início, nesta ordem: "Suas pesquisas" (se houver), "Afiliação" (se `affiliates:read`: disponível e em carência), "O que você pode fazer" (Nova pesquisa, Pesquisas, Créditos, Afiliação). Sem pesquisas, "O que você pode fazer" sobe para o primeiro bloco e o estado vazio de pesquisas some.
- Sem crédito, "Nova pesquisa" leva a Créditos (já é o fluxo de confirmar pedido e adicionar saldo). Confirmar o comportamento atual antes de mudar.
- Créditos: extrato no estilo Nubank. Grupos por data (título do grupo, ex.: "26 out"). Cada linha: ícone, nome (uma linha, corta com "…"), linha de baixo com hora + status (+ link "Recibo" quando existir), valor à direita. Verde e sinal "+" só para entrada paga. Expirado e Cancelado em cinza, sem sinal. Gastos com pesquisa entram no mesmo extrato com sinal "−" (decisão minha, o usuário não respondeu).
- Nova pesquisa: bloco curto no topo "O que é uma pesquisa?" (recolhível; começa aberto) e, em cada produto, resumo de uma linha com link "O que você recebe" que expande o detalhe. Aviso: o titular autoriza antes; o saldo só sai quando a consulta roda.
- Afiliação: bloco "Como funciona" em 5 passos no topo: (1) compartilhe o link; (2) a pessoa se cadastra e confirma o celular; (3) quando ela faz uma pesquisa, você ganha uma % do lucro do Bureau; (4) a comissão fica em carência por alguns dias e depois fica disponível; (5) converta em créditos ou saque por PIX, com taxa. Pedido estornado desfaz a comissão. Fonte das regras: `PRODUCT.md` (seção Afiliados) e `docs/operations/affiliates.md`. Os dias de carência e a taxa de saque vêm da configuração real; não escrever número fixo no texto.
- Página pública `/b/<slug>` (`src/app/b/[slug]/page.tsx`), nesta ordem: (1) promessa curta + "Criar conta"; (2) "Qual dossiê escolher": Dossiê Pessoa Física e Dossiê Empresarial em cartões (empilhados no celular), com preço do catálogo do Bureau incluindo "por sócio", e o parecer por IA como incluso em todo dossiê, sem custo extra (atualizado em 2026-10-26); (3) "Como funciona" em 4 passos: criar conta (e-mail e celular), saldo por PIX, pesquisa (titular autoriza), resultado em tela e PDF com aviso por e-mail e WhatsApp; (4) dúvidas (autorização do titular, quando o saldo sai, LGPD); botão "Criar conta" no topo, no fim e fixo embaixo, mais "Já tenho conta: entrar". Catálogo vazio: "Catálogo em breve" e o resto continua. Mantém título genérico e sem sinal de enumeração de slug. Descrições dos produtos: texto estático por código de produto (`dossie_pf`, `dossie_empresarial`), preço sempre do catálogo.
- Em todo o portal: texto longo corta com "…" (`truncate`, `min-w-0`) em vez de quebrar linha. Vale para nome de titular, linhas de lista, chip de saldo e linhas do extrato.

## Não metas

- Sem mudança em carteira, pedidos, pagamentos ou permissões.
- Sem novo componente de design system além do necessário (reusar `ListRow`, `Card`, `SectionHeader`, `StatusBadge`).
- Sem tema escuro nem painéis do Bureau/superadmin.

## Anti-metas

- Saldo visível em mais de um lugar além do chip do topo e da tela Créditos.
- Linha de lista com 2+ linhas de texto quebrado.
- Texto de explicação com número de carência ou taxa fixos que divergem da configuração.
- Perder o "Recibo", o status ou o botão de pagamento pendente das recargas (`PendingChargeButton`).

## Restrições

- Next 14 App Router, Server Components por padrão. Textos em pt-BR, Simplified Technical English. Mobile primeiro (cabe em ~360 px).
- Arquivos tocados provavelmente: `src/app/(portal)/portal/page.tsx`, `src/components/portal/portal-header.tsx`, `src/app/(portal)/portal/credits/page.tsx`, `src/app/(portal)/portal/afiliacao/page.tsx`, a tela de Nova pesquisa, `src/components/ui/list-row.tsx` e a lista de recargas/extrato. Existem alterações locais não commitadas em `(portal)/portal/credits/page.tsx`, `ClientTopupDialog.tsx` e `PendingChargeButton.tsx`: partir delas, não sobrescrever.
- Atualizar `docs/design.md` com as regras novas (saldo só em Créditos; truncar texto).
- Testes: só lógica ramificada (agrupar extrato por data, regra de sinal/cor por status, saldo oculto sem `credits:read`). Sem teste de apresentação pura. Ajustar `portal-header.test.ts` e `e2e/` afetados.

## Decisões do design (respostas à revisão; as marcadas "minha decisão" não foram dadas pelo usuário)

- Dados do extrato: usar `listClientLedger` (`src/lib/wallet/client-queries.ts`, tabela `client_ledger_entries`). Ela já tem os tipos `topup`, `reserve`, `capture`, `release`, `reversal`, `commission_credit`, `adjustment_*`. Sem query nova nem migração. Mapear cada `kind` para nome, sinal e cor numa função pura testada. Recargas PIX pendentes, expiradas e canceladas continuam vindo da lista de recargas atual, mescladas por data. Minha decisão: mostrar `capture` ("Pesquisa", −), `reversal` (estorno, +) e `topup`; não mostrar `reserve`/`release` como linhas (o valor aparece em "Reservado em pedidos").
- "Reservado em pedidos": mantém, no cartão de saldo de Créditos, só quando > 0. Minha decisão.
- Saldo oculto (olho): estado por navegador (localStorage), o mesmo em todas as páginas do portal; padrão visível. O chip do cabeçalho passa a ser um componente cliente pequeno; o valor vem do servidor. Minha decisão.
- Página pública: o catálogo continua vindo de `getPublicCatalog(slug)` (já existente, sem sinal de enumeração). "Catálogo vazio" = lista vazia. O botão "Criar conta" aponta para `/b/<slug>/cadastro`.
- Texto "O que você recebe": 2 textos estáticos, um por código (`dossie_pf`, `dossie_empresarial`) a partir dos textos do mockup. Existem só esses 2 códigos hoje. Código desconhecido: mostra só nome e preço, sem texto. Minha decisão.
- Afiliação: dias de carência e taxa de saque. A taxa vem de `readWithdrawalFee` (já usado na página). Se os dias de carência não estiverem legíveis para o cliente sem query nova, o texto diz "alguns dias" sem número. Minha decisão.
- "Nova pesquisa sem crédito": primeiro ler o fluxo atual. Se já levar a Créditos ou tratar saldo insuficiente, manter. Só mudar se o cliente ficar num beco sem saída.

## Cabe ao construtor

Estrutura exata dos componentes, textos finais dos produtos (usar o catálogo real, não os preços do mockup), tamanhos e espaçamentos, como recolher o bloco "O que é uma pesquisa?" (palpite: lembrar por navegador após a primeira leitura).

## Referências

Mockups: `.superpowers/brainstorm/72305-1793042406/content/portal-layout.html` e `nova-pesquisa.html` (aprovados pelo usuário; mistura de A e B na Nova pesquisa).
