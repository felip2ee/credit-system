import { describe, expect, it } from "vitest";

import { resultDisplayName } from "./map";
import type { DepsConsultResultPF, DepsConsultResultPJ } from "@/types/deps";

describe("resultDisplayName", () => {
  it("PJ → razão social", () => {
    const pj = {
      mix: { empresa: { data: { razaoSocial: "ACME LTDA" } } },
    } as unknown as DepsConsultResultPJ;
    expect(resultDisplayName("PJ", pj)).toBe("ACME LTDA");
  });

  it("PF → nome completo", () => {
    const pf = {
      mix: { pessoa: { data: { nome: "João da Silva" } } },
    } as unknown as DepsConsultResultPF;
    expect(resultDisplayName("PF", pf)).toBe("João da Silva");
  });

  it("retorna null quando o nome está ausente ou vazio", () => {
    const empty = {
      mix: { pessoa: { data: { nome: "   " } } },
    } as unknown as DepsConsultResultPF;
    expect(resultDisplayName("PF", empty)).toBeNull();

    const missing = { mix: {} } as unknown as DepsConsultResultPJ;
    expect(resultDisplayName("PJ", missing)).toBeNull();
  });
});
