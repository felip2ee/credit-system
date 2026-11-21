# Parecer de Crédito — Prompt da IA (Dossiê Estratégico de Crédito)

> Documento de referência. **A fonte da verdade são os arquivos de prompt:**
> `src/lib/ai/prompts/{shared,pf,pj,company}.ts`. Em divergência, vale o código.
> Os textos de `prompts/` são os defaults; o admin pode sobrescrevê-los na tabela
> `settings` (`ai_prompt_pf`, `ai_prompt_pj`, `ai_prompt_empresa`).
>
> Decisões já tomadas com o cliente:
> - Dado faltante → **"Não informado nos documentos analisados"** + `dados_faltantes`, nunca inventar.
> - Saída → **JSON híbrido** (campos estruturados + `relatorio_markdown` + `mapa_mental`).
> - Estrutura do relatório → **25 seções** do "Dossiê Estratégico de Crédito" (exemplo Riolax).

Versões: `PROMPT_VERSION = "parecer-v3"` (PF/PJ) e `COMPANY_PROMPT_VERSION = "parecer-empresa-v4"` (grupo), em `prompt.ts`. Suba a versão quando o prompt mudar de modo que afete a saída.

---

## 1. Organização do código

| Arquivo | Conteúdo |
|---|---|
| `prompt.ts` | Payload builders (`buildUserPayload`, `buildCompanyPayload`), versões, `OPENAI_MODEL`, `DEFAULT_AI_PROMPTS`, `aiPromptKey`. Re-exporta `SYSTEM_PROMPT_PF`, `SYSTEM_PROMPT_PJ`, `SYSTEM_PROMPT`, `COMPANY_SYSTEM_PROMPT`. |
| `prompts/shared.ts` | `RAINHA_RULES`, `jsonOutput()` (contrato JSON + `mapa_mental`) e `dossieSecoes6a25()`. |
| `prompts/pf.ts` | Analisador PF: seções 1 a 5 (3 e 5 aprofundadas; 4 "Não se aplica"). |
| `prompts/pj.ts` | Analisador PJ: seções 1 a 5 (4 e 5 aprofundadas; 3 "Não se aplica" para PF individual). |
| `prompts/company.ts` | Grupo: Parte 1 empresa (seção 4), Parte 2 sócios (seção 3 por sócio + seção 5 SCR do grupo), Parte 3 consolidação (seções 6 a 25). |

## 2. Regras invioláveis (`RAINHA_RULES`)

1. Nunca inventar dados; ausente vira "Não informado nos documentos analisados" e entra em `dados_faltantes`.
2. Percentuais de impacto e probabilidades são estimativas, marcadas "(estimativa do analista)".
3. O parecer é orientação técnica da Rainha Cred: não é decisão de crédito, nem garantia de aprovação (campo `disclaimer`).
4. A data vem de `data_analise`.
5. Tom técnico, bancário e didático; impacto de cada apontamento na política bancária.
6. Interpretação estratégica fica separada do dado literal, em parágrafo iniciado por "Leitura estratégica:".
7. Títulos `## N. Título` exatos, na ordem e numeração; nenhuma seção omitida.

## 3. As 25 seções (`relatorio_markdown`)

1. Propósito do dossiê
2. Visão executiva (tabela consolidada de indicadores)
3. Diagnóstico da pessoa física
4. Diagnóstico da pessoa jurídica
5. Análise do SCR
6. Análise dos pontos positivos e negativos
7. Diagnósticos anteriores
8. Matriz de crédito
9. Estratégia de bancos (relacionamento, oportunidade, linha específica, estrutura garantidora, estrutura de desenvolvimento)
10. Leitura da Rainha (como o banco enxerga o cliente; o que favorece; o que limita; principal gargalo; principal oportunidade; o que precisa acontecer antes de pedir crédito; qual crédito faz sentido; qual não faz; ordem das ações)
11. Trilha de alavancagem (Organizar, Fortalecer, Comprovar, Relacionar, Estruturar, Alavancar, Crescer — uma linha cada)
12. Jornada de 30 dias
13. Jornada de 60 dias
14. Jornada de 90 dias
15. Jornada de 180 dias
16. O que não deve ser feito
17. Mapa de alavancagem (Hoje / Próxima etapa / Depois / Destino)
18. Placar da jornada (indicador, situação atual, objetivo)
19. Parecer consolidado da Rainha (capacidade financeira, cadastral, risco bancário, potencial de alavancagem, conclusão estratégica)
20. Rota de crédito (Rota 1 Construção, 2 Estruturação, 3 Alavancagem, 4 Consolidação)
21. Linhas de crédito (instituição, aderência, finalidade, por que faz sentido, condições a verificar, fatores que podem impedir)
22. Mensagem final para o cliente ("Crédito não é dívida. Crédito é alavancagem.")
23. Regra da Rainha (Para quê? Quanto? Como? Sem as 3 respostas, não tomar a operação)
24. Nota técnica
25. Base documental

No prompt do grupo, cada ação da Parte 3 diz se é da empresa ou de qual sócio.

---

## 4. Contrato de entrada (mensagem do usuário)

```jsonc
{
  "tipo_pessoa": "PJ",                 // "PF" | "PJ"
  "data_analise": "2026-06-01",        // injetada pelo servidor (não inventar)
  "dados_bureau": { /* allow-list canônica: cadastro, score, pendências, protestos... */ },
  "bureau": { /* retorno completo da deps, podado (src/lib/ai/bureau-input.ts) */ }
}
```

No grupo: `dados_empresa` e `dados_socios[]`, cada um com `bureau` opcional.

## 5. Contrato de saída (JSON)

Campos consumidos pelo app, definidos por `ParecerSchema` (`src/types/ai.ts`): `tipo_pessoa`, `classificacao_perfil`, `apto`, `resumo_executivo`, `notas`, `fatores_decisivos`, `pontos_fortes`, `pontos_atencao`, `plano_acao` (`step`, `description`, `priority`), `produtos_sugeridos`, `top_oportunidades_imediatas`, `limite_sugerido`, `limite_sugerido_notas`, `dados_faltantes`, `mapa_mental`, `relatorio_markdown`, `disclaimer`.

`plano_acao` usa as etapas da seção 11 e as jornadas das seções 12 a 15.

### `mapa_mental` (opcional no schema)

```jsonc
"mapa_mental": {
  "centro": "string <=120",
  "ramos": [                                  // 1..8
    {
      "titulo": "string <=40",
      "tipo": "etapa" | "evitar",
      "nos": [                                // 1..6, uma linha cada
        {
          "texto": "string <=140",
          "prazo": "30_dias" | "60_dias" | "90_dias" | "180_dias" | "continuo",
          "dono": "empresa" | "nome do sócio"  // PF: "titular"
        }
      ]
    }
  ]
}
```

O mapa deriva do `plano_acao` e das jornadas, sem informação nova: 7 ramos `etapa` (os passos da Trilha, na ordem) mais 1 ramo `evitar` (seção 16).

## 6. Parâmetros de chamada (OpenAI)

- Modelo: `OPENAI_MODEL` (constante única).
- `response_format`: `json_object`; a saída é validada com `ParecerSchema` (`src/lib/ai/opinion.ts`).
- `temperature` só em modelos `gpt-3|4`; modelos de reasoning usam `max_completion_tokens`.
- `finish_reason === "length"` tem erro próprio (JSON truncado). O grupo usa mais tokens de saída.
- A chamada roda no servidor. A `OPENAI_API_KEY` nunca vai para o client.
