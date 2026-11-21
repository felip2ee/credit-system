import { describe, expect, it } from "vitest";

import { MapaMentalSchema, ParecerSchema, toAptitudeStatus } from "./ai";

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

  it("aceita parecer sem mapa_mental (payload antigo)", () => {
    const parsed = ParecerSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mapa_mental).toBeUndefined();
  });

  it("aceita parecer com mapa_mental válido", () => {
    expect(ParecerSchema.safeParse({ ...minimal, mapa_mental: mapaValido() }).success).toBe(true);
  });

  it("descarta mapa_mental inválido sem reprovar o parecer", () => {
    const mapa = { ...mapaValido(), ramos: [ramoValido([noValido({ texto: "x".repeat(141) })])] };
    const parsed = ParecerSchema.safeParse({ ...minimal, mapa_mental: mapa });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mapa_mental).toBeUndefined();
  });
});

function noValido(overrides: Record<string, unknown> = {}) {
  return { texto: "Separar contas PF e PJ", prazo: "30_dias", dono: "empresa", ...overrides };
}

function ramoValido(nos: unknown[] = [noValido()]) {
  return { titulo: "Organizar", tipo: "etapa", nos };
}

function mapaValido() {
  return { centro: "Aprovar crédito de R$ 200 mil", ramos: [ramoValido(), { ...ramoValido(), titulo: "Evitar", tipo: "evitar" }] };
}

describe("MapaMentalSchema", () => {
  it("aceita uma árvore válida", () => {
    expect(MapaMentalSchema.safeParse(mapaValido()).success).toBe(true);
  });

  it("rejeita 0 ramos", () => {
    expect(MapaMentalSchema.safeParse({ ...mapaValido(), ramos: [] }).success).toBe(false);
  });

  it("rejeita 9 ramos", () => {
    const ramos = Array.from({ length: 9 }, () => ramoValido());
    expect(MapaMentalSchema.safeParse({ ...mapaValido(), ramos }).success).toBe(false);
  });

  it("aceita 8 ramos e 6 nos (limites)", () => {
    const ramos = Array.from({ length: 8 }, () => ramoValido(Array.from({ length: 6 }, () => noValido())));
    expect(MapaMentalSchema.safeParse({ ...mapaValido(), ramos }).success).toBe(true);
  });

  it("rejeita ramo com 0 nos", () => {
    expect(MapaMentalSchema.safeParse({ ...mapaValido(), ramos: [ramoValido([])] }).success).toBe(false);
  });

  it("rejeita ramo com 7 nos", () => {
    const nos = Array.from({ length: 7 }, () => noValido());
    expect(MapaMentalSchema.safeParse({ ...mapaValido(), ramos: [ramoValido(nos)] }).success).toBe(false);
  });

  it("rejeita prazo fora do enum", () => {
    const ramos = [ramoValido([noValido({ prazo: "365_dias" })])];
    expect(MapaMentalSchema.safeParse({ ...mapaValido(), ramos }).success).toBe(false);
  });

  it("rejeita texto com 141 caracteres", () => {
    const ramos = [ramoValido([noValido({ texto: "a".repeat(141) })])];
    expect(MapaMentalSchema.safeParse({ ...mapaValido(), ramos }).success).toBe(false);
  });
});
