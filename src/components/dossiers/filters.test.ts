import { describe, expect, it } from "vitest";

import { dossierFilterParam, parseDossierFilter } from "./filters";

describe("parseDossierFilter", () => {
  it("mapeia os valores da URL para o tipo do Dossiê", () => {
    expect(parseDossierFilter("pf")).toBe("PF");
    expect(parseDossierFilter("pj")).toBe("PJ");
    expect(parseDossierFilter("pj-completo")).toBe("PJ_FULL");
  });

  it.each([undefined, "", "x", "PF"])("devolve undefined para %j", (value) => {
    expect(parseDossierFilter(value)).toBeUndefined();
  });

  it("faz ida e volta com dossierFilterParam", () => {
    for (const param of ["pf", "pj", "pj-completo"]) {
      expect(dossierFilterParam(parseDossierFilter(param))).toBe(param);
    }
    expect(dossierFilterParam(undefined)).toBeUndefined();
  });
});
