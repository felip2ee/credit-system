import { describe, expect, it } from "vitest";

import { adminEmailError, adminNameError } from "./admin-field-errors";

describe("admin field errors", () => {
  it("nome curto ou em branco dá erro; nome completo não", () => {
    expect(adminNameError("  ")).toBe("Informe o nome completo.");
    expect(adminNameError("Ma")).toBe("Informe o nome completo.");
    expect(adminNameError("Maria Souza")).toBeNull();
  });

  it("e-mail vazio ou inválido dá erro; válido não", () => {
    expect(adminEmailError("")).toBe("E-mail inválido.");
    expect(adminEmailError("x")).toBe("E-mail inválido.");
    expect(adminEmailError(" maria@exemplo.com ")).toBeNull();
  });
});
