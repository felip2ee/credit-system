import { describe, expect, it } from "vitest";

import { passwordFieldError } from "./password-error";

describe("passwordFieldError", () => {
  it("senha válida e igual à confirmação não tem erro", () => {
    expect(passwordFieldError("senha-bem-longa-1", "senha-bem-longa-1")).toBeNull();
  });

  it("senha curta aponta o campo da senha", () => {
    expect(passwordFieldError("curta", "curta")?.field).toBe("password");
  });

  it("confirmação diferente aponta o campo de confirmação", () => {
    expect(passwordFieldError("senha-bem-longa-1", "outra")).toEqual({
      field: "confirm",
      message: "As senhas não coincidem.",
    });
  });
});
