# Parecer: estrutura do Dossiê Riolax + mapa mental do plano de ação

Branch: `feat-parecer-mapa-mental` (base: `fix/pdf-parecer-dossie`).
Referência de conteúdo: `DOSSIE RIOLAX _ RHUAN.pdf` (25 seções).

## Objetivo

1. Os prompts PF, PJ e empresa passam a seguir as 25 seções do Dossiê Riolax.
2. A IA devolve um campo novo `mapa_mental` ligado ao `plano_acao`.
3. O mapa aparece como diagrama no PDF e na tela.

## Decisões

- `mapa_mental` é opcional no schema. Pareceres antigos e respostas sem o campo continuam válidos. Sem migration: o campo entra em `full_report` (jsonb).
- Profundidade fixa: centro → ramos → nós. Sem recursão. O layout fica previsível e o modelo erra menos.
- Ramos = as 7 etapas da trilha (Organizar, Fortalecer, Comprovar, Relacionar, Estruturar, Alavancar, Crescer) mais um ramo `evitar` ("O que não deve ser feito").
- Cada nó tem texto curto, prazo (30, 60, 90, 180 dias ou contínuo) e dono (`empresa` ou nome do sócio).
- O layout é uma função pura, compartilhada entre PDF (`@react-pdf` `Svg`) e tela (SVG no DOM).

## Contrato

```ts
MapaMental = {
  centro: string,                       // objetivo, máx. 120 caracteres
  ramos: {                              // 1..8
    titulo: string,                     // máx. 40
    tipo: "etapa" | "evitar",
    nos: {                              // 1..6
      texto: string,                    // máx. 140
      prazo: "30_dias" | "60_dias" | "90_dias" | "180_dias" | "continuo",
      dono: string,                     // "empresa" ou nome do sócio, máx. 60
    }[],
  }[],
}
```

## Tarefas

### 1. Schema
- Files: `src/types/ai.ts`, `src/types/ai.test.ts`
- Depends-on: none
- Agent: `backend-specialist` (sonnet)
- `MapaMentalSchema` com os limites acima. `ParecerSchema` ganha `mapa_mental: MapaMentalSchema.optional()`.
- Testes: aceita árvore válida; rejeita 0 ramos, 9 ramos, prazo fora do enum, texto acima do limite; parecer sem o campo continua válido.

### 2. Prompts (25 seções + mapa)
- Files: `src/lib/ai/prompt.ts` (fica só com payload builders e re-exports), `src/lib/ai/prompts/{shared,pf,pj,company}.ts` (novos), `src/lib/ai/parecer-prompt.md`, `src/lib/ai/bureau-input.test.ts`
- Depends-on: 1
- Agent: `backend-specialist` (sonnet)
- Divide `prompt.ts` (534 linhas, limite 350). Exporta os mesmos nomes públicos: `SYSTEM_PROMPT_PF`, `SYSTEM_PROMPT_PJ`, `COMPANY_SYSTEM_PROMPT`, `DEFAULT_AI_PROMPTS`, `aiPromptKey`, builders.
- Estrutura do relatório = 25 seções do Dossiê. Regras que valem em todas: regra 1 (dado ausente = "Não informado nos documentos", sem inventar), disclaimer, estimativas marcadas como "(estimativa do analista)".
- `JSON_OUTPUT` ganha `mapa_mental` com o contrato acima e um exemplo. Instrução: o mapa deriva de `plano_acao` e das jornadas; cada nó cabe em uma linha.
- Empresa: cada nó indica `dono` (empresa ou sócio).
- Sobe `PROMPT_VERSION` para `parecer-v3` e `COMPANY_PROMPT_VERSION` para `parecer-empresa-v4`. Atualiza as asserções em `bureau-input.test.ts`.
- Teste: cada prompt contém os títulos das seções e o bloco `mapa_mental`; `DEFAULT_AI_PROMPTS` tem as 3 chaves.

### 3. Layout puro
- Files: `src/lib/ai/mapa-mental-layout.ts`, `src/lib/ai/mapa-mental-layout.test.ts`
- Depends-on: 1
- Agent: `frontend-specialist` (sonnet)
- `layoutMapaMental(mapa, { width }) → { nodes, edges, height }`. Centro no meio, ramos radiais ou em colunas conforme a largura; quebra de linha por contagem de caracteres. Sem DOM, sem react-pdf.
- Testes: nenhum nó se sobrepõe; todo nó fica dentro de `width`; 1 ramo e 8 ramos × 6 nós; texto longo quebra em linhas.

### 4. Render no PDF
- Files: `src/lib/pdf/mapa-mental-pdf.tsx` (novo), `src/lib/pdf/markdown-pdf.tsx`, `src/lib/pdf/opinion-from-report.ts`, `src/app/(portal)/portal/pesquisas/[id]/pdf/route.ts`, `src/app/(dashboard)/dossiers/[id]/pdf/route.ts`, testes `markdown-pdf.test.ts`, `opinion-from-report.test.ts`
- Depends-on: 1, 3
- Agent: `frontend-specialist` (sonnet)
- `OpinionForPdf.mapaMental?`. Bloco do mapa logo depois de "Plano de ação" em `OpinionBlock`. Página própria em paisagem se a lib permitir; se não, página cheia com o mapa escalado.
- As duas rotas passam `mapa_mental` de `full_report`.
- Testes: PDF com mapa renderiza sem erro e contém os textos dos nós; sem mapa, saída igual à atual.

### 5. Render na tela
- Files: `src/components/parecer/mapa-mental.tsx` (novo), `src/components/consultations/consultation-opinion.tsx`, `src/components/dossiers/dossier-report-panel.tsx`, `src/components/orders/delivery-view.tsx`
- Depends-on: 1, 3
- Agent: `frontend-specialist` (sonnet), skill `ui-ux-pro-max`
- Componente SVG, tokens do `docs/design.md`, legível em 375 px (rola na horizontal dentro do cartão, sem estourar a página), `role="img"` com `aria-label` e lista equivalente para leitor de tela.
- Entra após o resumo e antes do relatório completo. Não renderiza nada sem `mapa_mental`.
- Teste do componente: renderização condicional (com e sem mapa) e a lista acessível.

## Ordem de execução

- Onda 1: tarefas 1.
- Onda 2 (arquivos disjuntos): 2 e 3.
- Onda 3 (arquivos disjuntos): 4 e 5.
- Gate por tarefa: testes escopados passam. Fecha com `npm run check` e `/code-review` uma vez.

## Fora do plano

- Salvar o mapa em coluna própria. O jsonb basta.
- Editar o mapa na tela.

## Post-deploy

- Qualidade da árvore gerada por um modelo real (tamanho dos textos, coerência com o `plano_acao`) em 2 ou 3 consultas reais. Entra como item de acompanhamento na descrição do PR. Não bloqueia o merge.
