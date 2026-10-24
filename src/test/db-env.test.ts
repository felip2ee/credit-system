import { afterEach, describe, expect, it } from "vitest";
import { assertLocal } from "./db-env";

const base = "postgres://postgres:test@localhost:54329/";

describe("assertLocal: nome do banco", () => {
  afterEach(() => {
    delete process.env.TEST_DATABASE_ALLOW_ANY_NAME;
  });

  it("recusa banco sem sufixo _test", () => {
    expect(() => assertLocal("X", `${base}credit_system`)).toThrow(
      "Testes só rodam em um banco cujo nome termina em _test (recebido: credit_system).",
    );
  });

  it("aceita banco terminado em _test", () => {
    expect(assertLocal("X", `${base}credit_system_test`)).toBe(`${base}credit_system_test`);
  });

  it("aceita qualquer nome com TEST_DATABASE_ALLOW_ANY_NAME=1", () => {
    process.env.TEST_DATABASE_ALLOW_ANY_NAME = "1";
    expect(assertLocal("X", `${base}credit_system`)).toBe(`${base}credit_system`);
  });

  it("mantém a checagem de host", () => {
    expect(() => assertLocal("X", "postgres://u:p@db.example.com/x_test")).toThrow(/local/);
  });
});
