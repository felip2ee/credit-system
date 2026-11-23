import { describe, expect, it } from "vitest";

import { AI_PROMPT_KINDS, COMPANY_SYSTEM_PROMPT, DEFAULT_AI_PROMPTS, SYSTEM_PROMPT_PF, SYSTEM_PROMPT_PJ } from "../prompt";

const SECTION_TITLES = [
  "Propósito do dossiê",
  "Visão executiva",
  "Diagnóstico da pessoa física",
  "Diagnóstico da pessoa jurídica",
  "Análise do SCR",
  "Análise dos pontos positivos e negativos",
  "Diagnósticos anteriores",
  "Matriz de crédito",
  "Estratégia de bancos",
  "Leitura da Rainha",
  "Trilha de alavancagem",
  "Jornada de 30 dias",
  "Jornada de 60 dias",
  "Jornada de 90 dias",
  "Jornada de 180 dias",
  "O que não deve ser feito",
  "Mapa de alavancagem",
  "Placar da jornada",
  "Parecer consolidado da Rainha",
  "Rota de crédito",
  "Linhas de crédito",
  "Mensagem final para o cliente",
  "Regra da Rainha",
  "Nota técnica",
  "Base documental",
];

const PROMPTS = { pf: SYSTEM_PROMPT_PF, pj: SYSTEM_PROMPT_PJ, empresa: COMPANY_SYSTEM_PROMPT };

describe("system prompts do dossiê", () => {
  it("lists the 25 sections as numbered ## headings", () => {
    expect(SECTION_TITLES).toHaveLength(25);
    for (const [kind, prompt] of Object.entries(PROMPTS)) {
      SECTION_TITLES.forEach((title, i) => {
        expect(prompt, `${kind}: ${title}`).toContain(`## ${i + 1}. ${title}`);
      });
    }
  });

  it("asks for mapa_mental with its contract and the premise lines", () => {
    for (const prompt of Object.values(PROMPTS)) {
      expect(prompt).toContain('"mapa_mental"');
      expect(prompt).toContain('"tipo": "etapa" | "evitar"');
      expect(prompt).toContain("Crédito não é dívida. Crédito é alavancagem.");
      expect(prompt).toContain("Não informado nos documentos analisados");
    }
  });

  it("sets the mapa_mental owner per prompt", () => {
    expect(SYSTEM_PROMPT_PF).toContain('"dono" é sempre "titular"');
    expect(COMPANY_SYSTEM_PROMPT).toContain("nome do sócio responsável");
  });

  it("registers the three defaults", () => {
    expect(AI_PROMPT_KINDS).toEqual(["pf", "pj", "empresa"]);
    expect(DEFAULT_AI_PROMPTS).toEqual({ pf: SYSTEM_PROMPT_PF, pj: SYSTEM_PROMPT_PJ, empresa: COMPANY_SYSTEM_PROMPT });
  });
});
