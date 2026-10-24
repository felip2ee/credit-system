# Consulta completa: mostrar 100% do retorno da deps

Data: 2026-10-19. Estado: aprovado pelo usuário (layout A, cliente vê tudo, IA recebe tudo exceto dados pessoais de contato).

## 1. Intenção

A tela da consulta, o PDF e o parecer por IA mostram hoje só uma fração do que a deps devolve: score, dados da pessoa, quatro contadores de restrição e mensagens. SCR, parecer Smart, renda presumida, contatos, endereços e qualquer módulo novo são descartados pelo adapter antes de chegar à tela. A Eliane lê tudo, decide, imprime o PDF e monta o plano de ação do cliente: todo dado da deps é relevante.

Objetivo: toda consulta, PF ou PJ, qualquer produto, mostra tudo o que a deps devolveu, na tela, no PDF e na entrada do parecer por IA. Módulos que o sistema não conhece aparecem do mesmo jeito, sem deploy.

## 2. Metas, não metas, antimetas

Metas:
- A tela da consulta (equipe) e a tela da pesquisa liberada (portal do cliente) mostram o payload inteiro.
- Os PDFs (consulta, dossiê, portal) mostram o mesmo conteúdo da tela, na mesma ordem.
- O parecer por IA recebe o payload inteiro, não só o resumo canônico.
- Consultas antigas aparecem completas sem nova consulta na deps e sem reprocessar o adapter.
- Um módulo novo da deps aparece na tela no dia em que a deps o devolve.

Não metas:
- Mudar o adapter, `CanonicalBureauResult` ou `ADAPTER_VERSION`. O resumo canônico continua alimentando listas, score e risco.
- Cards desenhados para módulos PJ (`empresa`, `quadroSocietario`, `balanco`, `faturamentoPresumido`, …). Nesta entrega eles passam pelo renderizador genérico. Ganham card quando houver um payload PJ real para desenhar.
- Controle por perfil do que o cliente vê. O cliente vê o mesmo que a equipe.
- Editar ou corrigir dados devolvidos pela deps.

Antimetas (seria falha mesmo funcionando):
- Qualquer chave do payload que não apareça em lugar nenhum da tela.
- Um módulo novo da deps que exija deploy para aparecer.
- Cliente do portal lendo payload de pedido não liberado.

## 3. Decisões tomadas

### 3.1 Fonte de dados: o payload bruto

A tela, o PDF e a IA leem `bureau_payloads.payload` (jsonb, já salvo em toda consulta concluída). Localização: a linha apontada por `bureau_results.payload_id` quando a consulta tem resultado (tela, PDF e IA usam o mesmo payload que gerou o canônico); sem `bureau_results`, a linha mais recente de `bureau_payloads` (`order by received_at desc limit 1`). Assim consultas `payload_incompatible` e `no_data` também mostram tudo para a equipe. Não leem `canonical_result` para o conteúdo; `canonical_result` segue para score/risco em listas e para o que já o usa.

Forma do payload: o adapter já aceita `[{mix}]`, `{mix}` ou o objeto `mix` direto (`extractMix`, `src/lib/deps/adapter.ts:95-101`). `toFullConsultationView` reutiliza `extractMix` (exportá-lo). Chaves no nível raiz fora de `mix` (hoje `consultasComplementares`) vão para `meta`.

Payload ausente (consulta purgada pela retenção LGPD, `db/migrations/023_lgpd_retention.sql`, ou consulta sem payload): a tela e o PDF caem para a visão atual a partir de `canonical_result`, com a nota "Dados completos não disponíveis". Sem `canonical_result` também: estado "indisponível" atual.

Motivo: nada se perde, consultas antigas ficam completas de imediato, módulo novo aparece sem código.

### 3.2 Layout: cards conhecidos + blocos genéricos (opção A, escolhida pelo usuário)

Ordem na tela e no PDF:

1. **Score**: `mix.score.data.{score, risco, descricao, scoreBoleto, probabilidadePagamento, descricaoPagamento}`.
2. **Parecer Smart**: `mix.smart.data.parecer.{aprovado, motivo, resultadoParecer[]}` (tabela: nome, atendido, percentual, percentualEsperado); `mix.smart.data.classificacao.{classificacao, limiteSugerido, porte, politica, validade, ticketMedio, pontuacaoAtingida}`; `positivas[]` e `negativas[]` (tabela: metrica, descricao, pontuacao, impacto, percentualMetrica). `todasClassificacoes[]` e `historicoClassificacao[]` ficam no card, recolhidos por padrão na tela e completos no PDF.
3. **SCR (Banco Central)**: `mix.scr.data`: totais `carteiraAtiva, carteiraCredito, riscoTotal, riscoAssumido, riscoIndireto, responsabilidadeTotal, coobrigacaoRecebida` (cada um `{valor, descricao, percentual}`); `vencimentosConsolidados.{itensAVencer, itensVencidos}` (tabela: descricao, valor, percentual; linha de total); `vencimentoPorModalidades[]` (uma tabela por modalidade, com `itens[].itensDetalhados[]`); `vencimentoPorModalidade.{prejuizo, coobrigacao, limiteCredito, creditoLiberar, repasseInterfinanceiro}`; `vencimentosConsolidados.informacaoConsulta[]` (pares descricao/valor).
4. **Renda presumida**: `mix.rendaPresumida.data.{valor, valorMinimo, valorMaximo, rendaPresumida, gastoEstimado, possuiGastoEstimado}`.
5. **Restrições**: como hoje (pendências, protestos, ações, cheques), lendo direto de `mix.pendenciasRestricoes`, `mix.protestos`, `mix.acoesJudiciais`, `mix.restricoesCheques`. Com dados, lista completa; sem dados, a `message` da deps ("Nada consta.").
6. **Pessoa**: `mix.pessoa.data` completo (nome, cpf mascarado, idade, dataNascimento, situacaoCadastral, nomeMae, obito, politicamenteExposta, …).
7. **Contatos e endereços**: `mix.contatosPreferenciais.data[]`, `mix.emails.data[]`, `mix.outrosEnderecos.data[]` como tabelas.
8. **Consultas**: `mix.consultas.data` (contagens por período).
9. **Outros dados**: todo módulo de `mix` que não está na lista acima e tem conteúdo, pelo renderizador genérico (3.3), na ordem do payload.
10. **Sem informação** (só calculado, nunca exibido): `view.missing` lista os módulos nulos ou com `data: null`. Serve de prova de que toda chave de `mix` tem destino.
11. **Dados da consulta** (só calculado, nunca exibido): `view.meta` guarda `versao, produto, dataConsulta, consultante, usuario, historicoConsultaId, isParcial, isGrupo, centroCusto, blocosComErros, linkCompartilhamento` e `consultasComplementares` (fora de `mix`). Nada do bureau (produto, links, ids, módulos ausentes) aparece na tela nem no PDF, para equipe ou cliente.

Dados de `mix.pessoa.data.rendaPresumida` e `mensagemErroRendaPresumida` vão para o card Renda presumida quando preenchidos.

### 3.3 Renderizador genérico

Regras, aplicadas a qualquer valor do payload:

- Envelope de módulo `{success, message, data, info}`: usa `data`; `message` vira a linha de texto quando `data` é nulo; `info` aparece como nota quando não nulo.
- Objeto: pares rótulo/valor. Objeto aninhado: sub-bloco com título, até profundidade 4; além disso, JSON formatado.
- Array de objetos: tabela, colunas = união das chaves escalares, na ordem da primeira ocorrência. Array de primitivos: lista separada por vírgula. Array vazio: "Nenhum".
- Célula de tabela nunca tem JSON. Valor que é registro ou array de registros vai para `nested` da linha e sai sob ela como sub-tabela (ou campos). A coluna some quando todas as linhas têm esse valor aninhado ou vazio. As regras R2 e R3 valem dentro do aninhado.
- Chaves `camelCase` viram rótulo legível ("rendaPresumida" → "Renda presumida"). Um dicionário em `src/lib/consultations/labels.ts` corrige rótulos conhecidos ("scr" → "SCR", "cpf" → "CPF", "uf" → "UF", …).
- Formatação: número cuja chave contém `valor`, `total`, `limite`, `ticket`, `renda`, `gasto` → BRL; string ISO 8601 → `dd/mm/aaaa` (ou com hora); boolean → "Sim"/"Não"; `null` → "—"; string com `%` fica como está.
- Chaves `cpf`, `cnpj`, `documento`: mascaradas com o utilitário já usado pela tela (`formatCPF`/`formatCNPJ`; a regra de máscara é a mesma da tela atual). Nunca aparecem completas no genérico.
- Identificadores nunca aparecem: chave `id` ou terminada em `Id` (`politicaId`, `historicoConsultaId`, `pontuacaoId`…), em campos, colunas e valores aninhados.
- Omite entradas com valor nulo, `""`, array ou objeto vazio, e as sobras de envelope `success` e `message` quando `message` é vazia. Campos nomeados dos cards tipados mantêm "—". Uma parte "Outros campos" sem campos some.
- Fora isso, nada é omitido. Em caso de dúvida, mostra como texto.

### 3.4 View-model

Nova função pura `toFullConsultationView(payload: unknown): FullConsultationView` em `src/lib/consultations/full-view.ts`, com tipos em `src/types/consultation-view.ts`. Produz: `sections` (cards tipados, cada um opcional), `generic: GenericBlock[]`, `missing: string[]`, `meta`. `toConsultationView` atual continua para o que depende dele.

A tela e o PDF consomem só `FullConsultationView`. Um componente React renderiza blocos genéricos na tela (`src/components/consultations/generic-block.tsx`); um componente `@react-pdf/renderer` renderiza o mesmo no PDF (`src/lib/pdf/generic-block.tsx`). Documentos PDF existentes excedem o limite de linhas e não podem crescer: as novas seções entram em arquivos novos, compostos pelo documento atual.

### 3.5 Portal do cliente

- Nova migration `db/migrations/NNN_bureau_payloads_client_released.sql`: política `bureau_payloads_client_released` para `select`, espelho exato de `bureau_results_client_released` (`db/migrations/022_orders_delivery.sql:1032-1038`), trocando a junção para `bureau_payloads.consultation_id`.
- `getMyDelivery` (`src/lib/orders/client-queries.ts`) passa a selecionar o payload mais recente de cada consulta do pedido (lateral join em `bureau_payloads`).
- A página `src/app/(portal)/portal/pesquisas/[id]/page.tsx`, `delivery-view` e a rota PDF do portal usam `toFullConsultationView`.
- Portal: só membros com `status = 'completed'` mostram o conteúdo completo; os demais mantêm "Resultado indisponível". O cliente não vê o rodapé "Dados da consulta" (item 11): `linkCompartilhamento` contorna máscara, revogação e purga, e `usuario`/`consultante`/`centroCusto` são internos do Bureau. Decisão da revisão de segurança.
- PDF do dossiê (equipe e portal): todas as seções de 3.2, por membro, sem limite de páginas. O documento atual (`dossier-document.tsx`) compõe o novo documento de consulta por membro.

### 3.6 Parecer por IA

- `buildUserPayload` (`src/lib/ai/prompt.ts`) recebe, além do canônico, `bureau: pruneForAi(payload)`: `mix` com envelopes desembrulhados (`data` no lugar do módulo; módulo sem `data` vira `{ message }`), módulos nulos removidos, chaves do rodapé (3.2 item 11) removidas, `cpf`/`cnpj` mascarados.
- Guarda de tamanho: se o JSON passar de 80.000 caracteres, remove `smart.historicoClassificacao`, depois `smart.todasClassificacoes`, depois `scr.vencimentoPorModalidade.vencimentoPorModalidades[].itens[].itensDetalhados`. Registra em `dados_faltantes` do parecer (vai para `ai_reports.full_report`) quais chaves foram removidas.
- `PROMPT_VERSION` → `parecer-v2`; `COMPANY_PROMPT_VERSION` → `parecer-empresa-v3`. Os prompts de sistema ganham um parágrafo: "O campo `bureau` traz o retorno completo do bureau; use SCR, parecer Smart e renda presumida no plano de ação."
- O relatório de grupo (dossiê, `buildCompanyPayload`) e as consultas PJ recebem o mesmo por membro, pelo mesmo `pruneForAi`.
- Dados pessoais fora da análise de crédito não vão para a IA: ver 3.7.

### 3.7 Segurança e LGPD

- RLS: a equipe já lê `bureau_payloads` (`bureau_payloads_staff`). O cliente só lê com pedido `released` (3.5). Teste de integração cobre: cliente do pedido liberado lê; cliente de pedido não liberado não lê; cliente de outro Bureau não lê.
- O payload tem CPF completo (`mix.pessoa.data.cpf`). Isso já é assim hoje; nada novo é armazenado. Tela, PDF e IA mascaram toda chave que contém `cpf`, `cnpj` ou `documento` (`isDocumentKey`, sem distinção de maiúsculas, ex. `cpfCnpj`, `documentoSocio`) em qualquer profundidade do payload (por chave, sem varrer strings livres).
- IA: orçamento total de 160.000 caracteres no parecer de grupo, dividido por igual entre empresa e sócios (`pruneCompanyForAi`). `numero`/`complemento` só caem dentro de objetos de endereço (preserva números de processo).
- Tela e PDF mostram `nomeMae`, telefones, e-mails e endereços completos (dado do próprio titular, lido por quem já o atende hoje).
- IA (OpenAI, terceiro), decisão do usuário: `pruneForAi` remove `pessoa.nomeMae`, `pessoa.dataNascimento`, `pessoa.identidade`, `pessoa.dadosCadastrais` (endereço residencial), `contatosPreferenciais`, `emails`, `outrosEnderecos` e, em qualquer profundidade, as chaves `telefone`, `telefones`, `email`, `emails`, `endereco`, `enderecos`, `cep` (equivalentes PJ). Esses dados não influenciam o parecer. Tudo o mais vai, com documentos mascarados.
- Máscara: `formatCPF` não mascara; a máscara é `maskDocumentValue` (`src/lib/mask-document.ts`, movido de `src/components/dossiers/`), mesma saída de `order_mask_document` no SQL.
- Logs não recebem o payload.

## 4. Restrições

- Sem dependência nova. `@react-pdf/renderer` e React já existem.
- Arquivos TypeScript ≤ 350 linhas. Os PDFs atuais não podem crescer.
- Strings de UI em pt-BR. Identificadores em inglês.
- Sem alteração em `bureau.ts` e `service.ts`. Em `adapter.ts`, só o `export` de `extractMix`.
- Fixture: cópia anonimizada do payload de hoje (nome, CPF, data de nascimento, telefones, e-mails, endereços, `usuario`, `consultante`, `historicoConsultaId`, `linkCompartilhamento` trocados por valores falsos; estrutura, chaves e números preservados) em `src/lib/deps/__fixtures__/smart-pf-002.json`. É a base dos testes de `full-view`, do genérico e do `pruneForAi`. O payload bruto está no banco local: `select payload from bureau_payloads where consultation_id='97ff10ca-d271-434d-a6e6-cddcfcc48ad1'`. Criar a fixture é a primeira tarefa do plano; as fixtures atuais (`pf-current.json`, …) não têm `scr`, `smart` completo, `rendaPresumida`, contatos nem endereços.

## 5. Testes (o que prova cada meta)

- `full-view.test.ts`: cada card tipado preenchido a partir da fixture; `missing` lista os módulos nulos; `generic` contém todo módulo com conteúdo fora da lista tipada; nenhuma chave de `mix` fica sem destino (teste percorre as chaves do payload e exige que cada uma esteja em `sections`, `generic`, `missing` ou `meta`).
- `generic-block.test.ts`: envelope, objeto, array de objetos, array vazio, profundidade > 4, rótulos, BRL, data, boolean, máscara de `cpf`.
- `prompt.test.ts`: `pruneForAi` remove nulos, rodapé e os dados pessoais de 3.7, mascara documento, aplica a guarda de tamanho na ordem definida.
- `rls.integration.test.ts`: os três casos de 3.7.
- Rotas PDF existentes (`route.test.ts` do portal): continuam verdes; o PDF contém os títulos "SCR", "Parecer Smart", "Renda presumida".

## 6. Fica com o implementador

- Componentes visuais dos cards (tipografia, grid), dentro do padrão shadcn/ui já usado em `consultation-result.tsx`.
- Dicionário inicial de rótulos.
- Quebra dos arquivos PDF novos.
- Nome e número da migration.

## 7. Critérios pós-deploy

- Primeira consulta Smart PJ 010 real: conferir que `empresa`, `quadroSocietario`, `balanco` aparecem pelo genérico e abrir item para cards PJ.
