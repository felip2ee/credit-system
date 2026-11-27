import { describe, expect, it } from "vitest";

import { BUREAU_STEPS, canLeaveStep, hasTypedData, stepErrors, type BureauCreateValues } from "./bureau-create-steps";

const empty: BureauCreateValues = { name: "", slug: "", adminName: "", adminEmail: "", adminPassword: "", confirm: "" };
const valid: BureauCreateValues = {
  name: "Bureau Sul",
  slug: "bureau-sul",
  adminName: "Maria Souza",
  adminEmail: "maria@exemplo.com",
  adminPassword: "",
  confirm: "",
};

describe("bureau create steps", () => {
  it("tem 2 etapas: Bureau e Administrador", () => {
    expect(BUREAU_STEPS.map((s) => s.id)).toEqual(["bureau", "admin"]);
  });

  it("etapa Bureau valida nome e slug com o schema da action", () => {
    expect(canLeaveStep("bureau", empty)).toBe(false);
    expect(Object.keys(stepErrors("bureau", empty))).toEqual(["name", "slug"]);
    expect(canLeaveStep("bureau", { ...empty, name: "A", slug: "Slug Ruim" })).toBe(false);
    expect(canLeaveStep("bureau", { ...empty, name: "A", slug: "abc" })).toBe(true);
  });

  it("etapa Bureau ignora erros de campos do administrador", () => {
    expect(canLeaveStep("bureau", { ...valid, adminEmail: "ruim" })).toBe(true);
  });

  it("etapa Administrador aceita senha em branco (convite por e-mail)", () => {
    expect(canLeaveStep("admin", valid)).toBe(true);
  });

  it("etapa Administrador exige nome e e-mail válidos", () => {
    expect(Object.keys(stepErrors("admin", { ...valid, adminName: "Ma", adminEmail: "x" }))).toEqual(["adminName", "adminEmail"]);
  });

  it("senha curta ou confirmação diferente barra a etapa, ligada ao campo certo", () => {
    expect(stepErrors("admin", { ...valid, adminPassword: "curta", confirm: "curta" })).toHaveProperty("adminPassword");
    expect(stepErrors("admin", { ...valid, adminPassword: "senha-bem-longa-1", confirm: "outra" })).toHaveProperty("confirm");
    expect(canLeaveStep("admin", { ...valid, adminPassword: "senha-bem-longa-1", confirm: "senha-bem-longa-1" })).toBe(true);
  });

  it("hasTypedData só vale com algo digitado", () => {
    expect(hasTypedData(empty)).toBe(false);
    expect(hasTypedData({ ...empty, name: "  " })).toBe(false);
    expect(hasTypedData({ ...empty, adminPassword: "x" })).toBe(true);
  });
});
