# PDF de consulta e de dossiê sobre o timbrado Rainha Cred — desenho

Data: 2026-11-19. Estado: aprovado pelo dono do produto em 2026-11-19.

## 0. Escopo desta entrega (branch `feat/pdf-timbrado`)

O dono do produto limitou esta entrega a **layout**. Outro agente trabalha em paralelo no defeito do parecer de IA e é dono das três rotas de PDF e de `opinion-from-report.ts`.

Entra nesta branch: tudo em `src/lib/pdf/` (moldura, escala visual, padrão de tabela, seções da consulta, capa e separadores do dossiê, bloco do parecer) e o arquivo do timbrado.

Fica para uma entrega seguinte, porque não é layout ou porque toca as rotas:

- Contatos no superadmin (seção 6.7): migração, tela, ação e leitura. Nesta entrega a moldura aceita `whatsapp` e `instagram` **opcionais** em `PdfFrame` e imprime só o que receber; as rotas continuam a passar apenas `supportEmail`.
- Nome do usuário no lugar do ID interno (seção 6.4): exige carga nova nas rotas. Nesta entrega o renderizador omite "· Usuário …" quando o valor é um UUID.
- Seção 7 "Fica": a correção do parecer não está nesta branch; pertence ao outro agente.

Regra dura: nenhum arquivo em `src/app/` é editado nesta branch, e nenhum nome exportado por `src/lib/pdf/` muda de assinatura de forma incompatível (as rotas e o outro agente dependem deles).

## 1. Intenção

O PDF de crédito é difícil de ler. As tabelas não seguem uma grade, textos colam ou vazam, os títulos não têm hierarquia e o documento não diz se é uma consulta ou um dossiê. O dono do produto quer manter **todos os dados** e mudar só a apresentação: um relatório bonito, moderno e fácil de ler, sobre o papel timbrado da Rainha Cred.

Quem lê: a equipe do Bureau e o cliente final (portal). O mesmo padrão vale para os três PDFs.

## 2. Objetivos, não-objetivos, anti-objetivos

Objetivos:

1. Um padrão visual único para o PDF da consulta, o PDF do dossiê (equipe) e o PDF do portal do cliente.
2. Um padrão único de tabela: linhas alternadas, tipos de coluna com alinhamento e largura fixos, cabeçalho repetido na quebra de página.
3. Primeira página com resumo: Score, Classificação, Parecer, Limite sugerido, Total SCR.
4. O documento diz o que é (consulta ou dossiê) e de quem é cada página.
5. Rodapé com os contatos da Rainha Cred, iguais em todos os PDFs, editados no superadmin.

Não-objetivos (ficam para outro projeto):

- Renomear "dossiê / pesquisa / consulta" nas telas, no menu e nos e-mails.
- Mudar quais dados a consulta busca, o preço ou o fluxo do pedido.
- Mudar a regra de mascaramento de CPF/CNPJ que cada rota já aplica.
- Recolocar na fila um parecer de IA que falhou (`ai_status = 'failed'`).

Anti-objetivos (o projeto falha se isto acontecer):

- Um dado que a API devolve deixa de aparecer no PDF.
- Texto sobre a chave dourada, a medalha ou as faixas do timbrado.
- Valor monetário ou percentual formatado de duas formas no mesmo documento.

## 3. Restrições

- `@react-pdf/renderer` 4.5.1, renderização no servidor (`renderToBuffer`). Sem dependência nova.
- react-pdf não repete cabeçalho de tabela na quebra de página e `minPresenceAhead` em `Text` não funciona. A repetição é feita em blocos (seção 6.3).
- PDF nunca é guardado: cada download renderiza de novo. O custo de renderização conta.
- Regras do projeto: SQL cru com `withUserTransaction`, zod, auditoria na mesma transação da mutação, migração nova (`048_…`), nunca editar migração aplicada, textos em pt-BR.
- `consultation-full-document.tsx` e `consultation-document.tsx` já passam do limite de linhas: não podem crescer.

## 4. Caminhos considerados

| Caminho | O que é | Troca |
|---|---|---|
| A. Só o motor genérico | Zebra e tipos de coluna detectados automaticamente em todas as tabelas. | Barato; todo dado novo aparece sozinho. Endereço e SCR continuam na forma crua da API. |
| **B. A + seções desenhadas (escolhido)** | Resumo, score, classificação, regras, métricas, SCR, endereços e contatos desenhados à mão. O resto cai no motor genérico. | Melhor leitura onde mais se olha; nada se perde. Mais código que A. |
| C. Tudo à mão | Cada seção com layout próprio. | Melhor acabamento; um campo novo da API some até alguém programar. Contra "maior riqueza de dados". |

O dono do produto escolheu **B**. Duas amostras descartáveis foram renderizadas; a segunda (sobre o timbrado) foi aprovada como rumo visual.

## 5. Decisões do dono do produto

- Caminho B.
- Fonte Helvetica (zero liso). A Atkinson Hyperlegible sai dos PDFs: o zero cortado atrapalha a leitura de valores.
- O timbrado é o fundo; a versão final é `Timbrado_A4.png` (terceira versão enviada; as duas anteriores estão descartadas). A logo Rainha Cred fica no topo. Os contatos ficam na faixa de baixo.
- O estilo de conteúdo da amostra 2 está aprovado: sem caixas nem faixas escuras, indicadores soltos, títulos verdes com traço dourado, cabeçalho de tabela pequeno em maiúsculas, zebra muito sutil.
- Contatos do rodapé: e-mail, WhatsApp e Instagram **da Rainha Cred**, iguais em todo PDF, definidos no superadmin.
- Todos os dados ficam.

## 6. Desenho

### 6.1 Moldura da página (todas as páginas, os três PDFs)

- A4. Timbrado final (`Timbrado_A4.png`, 2480×3508, proporção A4 exata) como imagem `fixed` de fundo em toda página, sem corte nem distorção. Entra no PDF como JPEG reduzido (cerca de 1240×1754, q85, perto de 100 KB; o PNG original tem 1,6 MB). A imagem é embutida uma vez por documento.
- Elementos do timbrado: faixa verde fina com fio dourado no topo; chave dourada no canto superior direito; faixa verde com fio dourado na base; medalha dourada no canto inferior esquerdo. Não há aba para a logo.
- Área segura: quem constrói mede o arquivo final. Referência da amostra 3 (timbrado anterior, mesmo desenho): topo 92 pt, base 96 pt, laterais 46 pt; a chave ocupa o canto direito até cerca de 115–125 pt de altura. O conteúdo nunca toca faixa, chave ou medalha. Na primeira página, o bloco de identidade fica à esquerda da chave.
- Logo oficial verde-água (`public/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.png`, sem recolorir), cerca de 52 pt de altura, no canto superior esquerdo sobre o branco.
- Faixa de baixo, à direita da medalha, em uma linha: e-mail · WhatsApp · Instagram em branco; "Página X de Y" à direita em dourado claro.
- Da segunda página em diante, ao lado da logo: nome do titular (ou papel + nome do membro, no dossiê) + documento como a rota já o entrega + "<tipo do documento> (continuação)". react-pdf não sabe em qual seção a página está; a linha não nomeia a seção.
- O nome do Bureau emissor sai do topo. Continua na linha "Confidencial para <Bureau>".

*Chamada do autor:* logo em todas as páginas (variante "a" da amostra 3). A variante "b" (logo só na primeira) ocupa a mesma altura e deixa uma faixa vazia.

### 6.2 Escala visual

- Helvetica. Nome 22 pt; indicadores 18; título de seção 12 negrito verde com traço dourado acima; corpo 10; tabela 9; cabeçalho de tabela 8,5 em maiúsculas.
- Cores: texto `#1E2A26`, apagado `#6B7773`, verde `#0B7A66`, dourado texto `#8F6B1F`, dourado traço `#C9A24A`, linhas `#D6DCD9` / `#E6EAE8`, zebra `#F8F9F8`, positivo `#1F7A5A`, negativo `#B3402F`.
- Cor de estado só onde carrega sentido (aprovado, reprovado, atendido, não atendido).
- Uma escala de espaçamento; o mesmo espaço acima de todo título de seção.

### 6.3 Padrão de tabela (um só)

- Cabeçalho: rótulo pequeno em maiúsculas, traço fino abaixo, sem fundo. Sem linhas verticais. Linhas de 18 pt, zebra `#F8F9F8`.
- Tipo de coluna define alinhamento e largura (pt):

| Tipo | Alinhamento | Largura | Formato |
|---|---|---|---|
| Texto | esquerda | divide o resto | quebra dentro da célula |
| Dinheiro | direita | 84 | `R$ 1.234,56` |
| Percentual | direita | 78 | sempre 2 casas, `12,34%` |
| Número / pontos | direita | 56 | sinal explícito quando é pontuação |
| Data | esquerda | 66 | `dd/mm/aaaa` |
| Sim/Não | centro | 52 | texto curto; cor só no "Não" que importa |
| Texto curto (operadora, tipo, resultado) | esquerda | 80 | — |

- O cabeçalho segue o alinhamento da coluna. As larguras de uma linha somam a largura útil.
- Coluna em que toda célula é vazia não é desenhada.
- Linha de subtotal em negrito; filhos recuados (SCR por modalidade).
- Texto nunca sai da célula. Token longo sem espaço (URL, número grande) quebra por regra de hifenização.
- Quebra de página: as linhas são agrupadas em blocos que não quebram; cada bloco leva o cabeçalho; o bloco de continuação leva "<seção> (continuação)". Nenhuma linha é partida. Nenhum cabeçalho fica sozinho no fim da página.
- O tamanho dos blocos é calculado pelo número de linhas, não ajustado à mão para um caso. Critério: nenhuma página intermediária com menos de 60% da área útil ocupada por causa de um bloco que não coube.

### 6.4 Seções desenhadas (consulta)

Ordem: identidade → resumo → score → classificação → parecer (regras) → métricas → SCR → identificação e cadastro → endereços → contatos e e-mails → consultas anteriores → demais dados (motor genérico) → parecer de IA.

- **Identidade:** linha superior "RELATÓRIO DE CONSULTA · <produto>"; nome; documento, nascimento, situação cadastral, renda presumida, data da consulta; "Confidencial para <Bureau> · <nome do usuário>". O PDF deixa de imprimir o ID interno do usuário. *Chamada do autor:* imprime o nome do usuário da sessão; hoje as três rotas passam `session.userId` em `header.usuario`, então cada rota passa a carregar o nome. Sem nome, a parte "· <usuário>" some.
- **Resumo:** cinco indicadores sem borda, separados por fio vertical: Score (com faixa de risco), Classificação, Parecer, Limite sugerido, Total SCR. Indicador sem dado mostra "—".
- **Score:** trilha fina de cinco faixas com marcador; rótulo sob cada faixa; "+ risco" e "− risco" presos às pontas; descrição abaixo.
- **Classificação:** trilha E, D, C, B, BB, BBB, A, AA, AAA com a atual destacada; pontuação atingida, validade e política abaixo. A tabela "todas as classificações" e o histórico seguem como tabelas no padrão.
- **Parecer (regras):** título com "N/N regras obrigatórias satisfeitas". Cada grupo é uma linha discreta: nome em negrito, contagem apagada, ponto de estado à direita. As regras do grupo ficam abaixo, recuadas, no padrão de tabela.
- **Métricas positivas e negativas:** colunas Métrica, Valor apurado, Pontos, Impacto, % métrica.
- **SCR:** totais; depois cada grupo (a vencer, vencidos, prejuízo, limite, coobrigação) com as **mesmas** colunas Descrição / Valor / Percentual, modalidade como subtotal em negrito e faixas de prazo recuadas.
- **Endereços:** uma linha por endereço (logradouro, número, complemento, bairro, município/UF, CEP).
- **Contatos:** telefone, operadora, WhatsApp (coluna some se vazia). E-mails em lista, um por linha.
- **Demais dados:** toda seção sem layout próprio usa o motor genérico com o mesmo padrão de tabela e de campos (grade de 2 colunas a 50%). É a garantia de que nada se perde.

### 6.5 Parecer de IA

- Sempre imprime, nesta ordem, o que existir: selo de aptidão e perfil, limite sugerido e notas, resumo, pontos fortes, pontos de atenção, plano de ação, relatório em texto. Hoje, quando há relatório em texto, os campos estruturados não são impressos.
- Tabelas do relatório em texto usam o padrão 6.3.

### 6.6 Dossiê

- **Capa (primeira página):** linha superior "DOSSIÊ · <Pessoa Física | Empresarial>"; nome e documento do titular; data; tabela de membros: Papel (Empresa, Titular, Sócio), Nome, Documento, Situação da consulta. Um dossiê PF também tem capa, com um membro.
- Cada membro começa em página nova com "<Papel> · <produto>" na linha superior da identidade.
- A linha de continuação (6.1) mostra papel + nome do membro em todas as páginas dele.
- A frase "Documento gerado automaticamente" só aparece no fim do dossiê, não ao fim de cada membro.
- O PDF do portal do cliente já renderiza por `renderDossierPdf`: usa a mesma capa e o mesmo layout, sem variação própria.
- Parecer: PJ completo imprime o parecer consolidado no fim. PF e PJ simples imprimem o parecer da consulta principal (correção já feita no working tree: `opinionFromAiReport`).

### 6.7 Contatos no superadmin

- Três chaves em `settings`: `contact_email`, `contact_whatsapp`, `contact_instagram`. Valor `jsonb` texto ou ausente.
- Validação (zod e `check` na tabela, como `payable_retention_days`): e-mail válido; WhatsApp em E.164 (`+55…`), impresso formatado; Instagram como `@usuario` (1 a 30 caracteres: letras, números, ponto, sublinhado).
- *Chamada do autor:* subrota nova `/superadmin/settings/contatos` (as configurações existentes já são subrotas, como `/superadmin/settings/repasses`), com entrada na página raiz e o padrão de `savePayableRetentionAction`: `settings:write`, `upsertSettings`, evento de auditoria `settings.contacts`.
- Leitura: uma função `SECURITY DEFINER` `platform_contacts()` (dono `auth_profile_lookup`, `search_path = pg_catalog, public`, `revoke all from public`, `grant execute to app_runtime`), porque o cliente do portal não lê `settings`. As três rotas de PDF leem por ela. Migração `048_platform_contacts.sql`.
- Campo vazio não aparece no rodapé. Sem `contact_email`, o rodapé usa `config.supportEmail` (comportamento de hoje).
- *Chamada do autor:* a entrega não espera o preenchimento. Com os três vazios o rodapé sai só com o e-mail de suporte; o superadmin preenche depois do deploy.
- Grants da função: seguir o padrão de `028` (`revoke all … from public`, `grant execute … to app_runtime`); o papel `app_runtime` vem de `001_roles.sql`.
- Os contatos são dados públicos da plataforma: não entram em mascaramento nem em regra de PII.

### 6.8 Arquivos de marca

- Timbrado: o dono do produto forneceu o arquivo final (`~/Downloads/Timbrado_A4 (1).png`, 2480×3508). O JPEG reduzido entra no repositório, junto dos arquivos de marca existentes (`public/brand/rainha-cred/`). O PNG de origem não entra.
- Logo: a oficial verde-água que já existe. Nenhum arquivo novo de logo é necessário.

## 7. Estado atual do working tree

- **Fica:** correção do parecer no PDF do dossiê (`src/lib/pdf/opinion-from-report.ts`, as duas rotas da equipe e os testes).
- **Sai:** o rascunho de layout feito antes deste desenho em `src/lib/pdf/` (`brand-frame.tsx`, `generic-block.tsx`, `consultation-full-document.tsx`, `markdown-pdf.tsx`, `complete-consultation-document.tsx`, `fonts.ts`, `generic-block.test.ts`). *Chamada do autor:* reverter esses arquivos e construir o padrão novo a partir do código commitado; reaproveitar só a regra de hifenização de token longo.
- O caminho ativo da consulta é `complete-consultation-document.tsx` (`renderCompleteConsultationPdf`), que o dossiê também importa. O plano parte dele, não de `consultation-full-document.tsx`.
- Os testes commitados que importam esses arquivos (`brand-frame.test.ts`, `complete-consultation-document.test.ts`, `generic-block.test.ts`) são reescritos para o layout novo, na mesma tarefa.
- As amostras ficam no scratchpad da sessão e não entram no repositório. A amostra 3 (`spike3/spike3.test.tsx`, variante "a") é referência de medidas, cores e posição de logo e rodapé, não código a copiar. Defeito conhecido dela, que a versão real não repete: uma tabela partida em dois blocos na mesma página, com cabeçalho e "(continuação)" repetidos sem quebra de página.

## 8. Testes e critérios de aceite

- Unidade: detecção de tipo de coluna e larguras (somam a largura útil; coluna vazia some); formatadores de dinheiro, percentual e data; divisão de linhas em blocos; mapeamento do parecer; validadores dos três contatos.
- Integração (Postgres real): `platform_contacts()` lê para equipe e para cliente do portal; só superadmin grava; `check` recusa valor inválido. Caso novo em `src/lib/db/rls.integration.test.ts`.
- Rotas: os três PDFs passam contatos e parecer ao renderizador.
- Renderização: um teste gera o PDF dos fixtures PF e PJ e de um dossiê PJ completo, e confere que todo rótulo e valor da entrada aparece no texto do PDF (prova de "nada se perde"). Sem snapshot de PDF inteiro.
- Conferência visual única, dentro da tarefa de layout: renderizar PF, PJ e dossiê PJ completo com sócios, e olhar as páginas contra os anti-objetivos.
- `(pós-deploy)` Baixar um PDF real de consulta e um de dossiê em produção e conferir rodapé com os contatos do superadmin.

## 9. O que fica com quem constrói

- Estrutura de arquivos em `src/lib/pdf/` (dividir os arquivos grandes em vez de fazê-los crescer).
- Algoritmo de blocos de tabela, desde que cumpra o critério de 6.3.
- Regras de detecção de tipo de coluna a partir do view-model.
- Destino de `consultation-document.tsx`, hoje sem nenhum importador (código morto anterior a este trabalho: mencionar, não apagar sem pedido).
- Atualizar `src/lib/pdf/CLAUDE.md` (fonte, moldura) e `docs/design.md` junto com a mudança.
