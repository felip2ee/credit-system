import { describe, it, expect } from "vitest";
import { summarizeProtestos, countProtestos } from "./protestos";

// Formato real devolvido pela deps na consulta do José Ailton (objeto, não lista).
const real = {
  situacao: null,
  cartorios: [
    {
      uf: "TO",
      nome: "99-CARTORIO DE REGISTRO CIVIL ... TABELIONATO DE PROTESTO",
      protestos: [{ data: null, valor: 5662.87, temAnuencia: false }],
      quantidadeProtestos: null,
    },
  ],
  valorTotal: 5662.87,
  quantidadeTotal: 1,
  ultimasOcorrencias: [{ uf: "TO", data: null, valor: 5662.87, cartorio: "99-CARTORIO..." }],
};

describe("summarizeProtestos", () => {
  it("conta o protesto no formato objeto da deps", () => {
    const r = summarizeProtestos(real);
    expect(r.total).toBe(1);
    expect(r.valorTotal).toBe(5662.87);
    expect(r.ocorrencias).toHaveLength(1);
    expect(r.ocorrencias[0].uf).toBe("TO");
    expect(r.ocorrencias[0].valor).toBe(5662.87);
  });

  it("nada consta → zero", () => {
    expect(countProtestos(null)).toBe(0);
    expect(countProtestos({ quantidadeTotal: 0, cartorios: [] })).toBe(0);
    expect(countProtestos([])).toBe(0);
  });

  it("aceita o formato legado em lista", () => {
    const r = summarizeProtestos([{ cartorio: "1º Ofício", uf: "SP", data: "2025-01-10", valor: 100 }]);
    expect(r.total).toBe(1);
    expect(r.valorTotal).toBe(100);
  });
});
