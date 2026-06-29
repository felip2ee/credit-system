import { describe, expect, it } from "vitest";

import { ParecerSchema, toAptitudeStatus } from "./ai";

describe("toAptitudeStatus", () => {
  it("mapeia a aptidão pt-br para o enum do banco", () => {
    expect(toAptitudeStatus("apto")).toBe("apt");
    expect(toAptitudeStatus("apto_com_ressalvas")).toBe("apt_with_caveats");
    expect(toAptitudeStatus("inapto")).toBe("inapt");
  });
});

describe("ParecerSchema", () => {
  // Payload mínimo válido — só os campos sem default.
  const minimal = {
    tipo_pessoa: "PF",
    classificacao_perfil: "Bom",
    apto: "apto",
    resumo_executivo: "Resumo.",
    notas: {
      cadastro: 8,
      score: 7,
      scr: 6,
      relacionamento_bancario: 5,
      capacidade_financeira: 7,
      garantias: 4,
      risco: 6,
      potencial_aprovacao: 7,
      final: 6.5,
    },
    fatores_decisivos: {
      maior_positivo: "Score alto",
      maior_negativo: "Pouca garantia",
      prioritario_intervencao: "Reforçar garantias",
    },
    relatorio_markdown: "# Parecer",
    disclaimer: "Uso interno.",
  };

  it("aceita um parecer mínimo e aplica defaults", () => {
    const parsed = ParecerSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // arrays opcionais viram [] por default
      expect(parsed.data.pontos_fortes).toEqual([]);
      expect(parsed.data.produtos_sugeridos).toEqual([]);
      // limite default null
      expect(parsed.data.limite_sugerido).toBeNull();
    }
  });

  it("rejeita classificação de perfil fora do enum", () => {
    const bad = { ...minimal, classificacao_perfil: "Ótimo" };
    expect(ParecerSchema.safeParse(bad).success).toBe(false);
  });

  it("rejeita nota fora do intervalo 0..10", () => {
    const bad = { ...minimal, notas: { ...minimal.notas, final: 11 } };
    expect(ParecerSchema.safeParse(bad).success).toBe(false);
  });

  it("rejeita aptidão inválida", () => {
    const bad = { ...minimal, apto: "talvez" };
    expect(ParecerSchema.safeParse(bad).success).toBe(false);
  });
});
