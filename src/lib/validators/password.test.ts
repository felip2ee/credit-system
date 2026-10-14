import { describe, expect, it } from "vitest";

import { newPasswordSchema, optionalPasswordSchema, passwordSchema } from "./password";

describe("passwordSchema", () => {
  it.each([
    [11, false],
    [12, true],
    [128, true],
    [129, false],
  ])("length %i -> valid %s", (length, valid) => {
    expect(passwordSchema.safeParse("a".repeat(length)).success).toBe(valid);
  });
});

describe("optionalPasswordSchema", () => {
  it("turns an empty or missing value into undefined", () => {
    expect(optionalPasswordSchema.parse("")).toBeUndefined();
    expect(optionalPasswordSchema.parse(undefined)).toBeUndefined();
  });

  it("validates a filled value", () => {
    expect(optionalPasswordSchema.safeParse("curta").success).toBe(false);
    expect(optionalPasswordSchema.parse("a".repeat(12))).toBe("a".repeat(12));
  });
});

describe("newPasswordSchema", () => {
  it("reports a mismatch on the confirm field", () => {
    const result = newPasswordSchema.safeParse({ password: "a".repeat(12), confirm: "b".repeat(12) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({ path: ["confirm"], message: "As senhas não coincidem." });
    }
  });

  it("accepts matching passwords", () => {
    expect(newPasswordSchema.safeParse({ password: "a".repeat(12), confirm: "a".repeat(12) }).success).toBe(true);
  });
});
