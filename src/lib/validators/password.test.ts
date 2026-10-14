import { describe, expect, it } from "vitest";

import { z } from "zod";

import {
  firstPasswordError,
  newPasswordSchema,
  optionalPasswordSchema,
  passwordSchema,
  refineOptionalNewPassword,
} from "./password";

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

describe("firstPasswordError", () => {
  const ok = "a".repeat(12);

  it("returns null for matching valid passwords", () => {
    expect(firstPasswordError(ok, ok)).toBeNull();
  });

  it("returns the length messages", () => {
    expect(firstPasswordError("curta", "curta")).toBe("A senha deve ter ao menos 12 caracteres.");
    expect(firstPasswordError("a".repeat(129), "a".repeat(129))).toBe(
      "A senha deve ter no máximo 128 caracteres.",
    );
  });

  it("returns the mismatch message", () => {
    expect(firstPasswordError(ok, "b".repeat(12))).toBe("As senhas não coincidem.");
  });
});

describe("refineOptionalNewPassword", () => {
  const schema = z
    .object({ pw: z.string(), confirm: z.string() })
    .superRefine((v, ctx) => refineOptionalNewPassword(ctx, { password: v.pw, confirm: v.confirm, passwordPath: "pw" }));
  const issues = (pw: string, confirm: string) => {
    const r = schema.safeParse({ pw, confirm });
    return r.success ? [] : r.error.issues.map((i) => ({ path: i.path, message: i.message }));
  };

  it("accepts blank password and blank confirm", () => {
    expect(issues("", "")).toEqual([]);
  });

  it("rejects short and too long passwords on the password path", () => {
    expect(issues("curta", "curta")).toEqual([
      { path: ["pw"], message: "A senha deve ter ao menos 12 caracteres." },
    ]);
    expect(issues("a".repeat(129), "a".repeat(129))).toEqual([
      { path: ["pw"], message: "A senha deve ter no máximo 128 caracteres." },
    ]);
  });

  it("reports mismatch on confirm, also when password is blank", () => {
    expect(issues("a".repeat(12), "b".repeat(12))).toEqual([
      { path: ["confirm"], message: "As senhas não coincidem." },
    ]);
    expect(issues("", "x")).toEqual([{ path: ["confirm"], message: "As senhas não coincidem." }]);
  });

  it("accepts equal valid passwords", () => {
    expect(issues("a".repeat(12), "a".repeat(12))).toEqual([]);
  });
});
