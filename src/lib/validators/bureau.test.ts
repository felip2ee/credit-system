import { describe, expect, it } from "vitest";

import { bureauCreateSchema, bureauUpdateSchema } from "./bureau";

const valid = {
  name: "Bureau Alfa",
  slug: "bureau-alfa",
  adminName: "Maria Souza",
  adminEmail: "maria@example.test",
};

describe("bureauCreateSchema", () => {
  it("accepts a valid input and normalizes the e-mail", () => {
    const parsed = bureauCreateSchema.safeParse({ ...valid, adminEmail: " Maria@Example.test " });
    expect(parsed.success && parsed.data.adminEmail).toBe("maria@example.test");
  });

  it.each(["AB", "ab", "a".repeat(41), "a_b", "Abc"])("rejects slug %j", (slug) => {
    expect(bureauCreateSchema.safeParse({ ...valid, slug }).success).toBe(false);
  });

  it("accepts a 40-character slug", () => {
    expect(bureauCreateSchema.safeParse({ ...valid, slug: "a".repeat(40) }).success).toBe(true);
  });

  it("rejects a name with only spaces", () => {
    expect(bureauCreateSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("rejects an invalid admin e-mail", () => {
    expect(bureauCreateSchema.safeParse({ ...valid, adminEmail: "x" }).success).toBe(false);
  });
});

describe("bureauUpdateSchema", () => {
  it("requires a uuid id and a non-blank name", () => {
    const id = "6f1c2c1e-0b6e-4b8e-9a53-3a0e2f6f4d11";
    expect(bureauUpdateSchema.safeParse({ id, name: "Novo" }).success).toBe(true);
    expect(bureauUpdateSchema.safeParse({ id: "x", name: "Novo" }).success).toBe(false);
    expect(bureauUpdateSchema.safeParse({ id, name: "  " }).success).toBe(false);
  });
});
