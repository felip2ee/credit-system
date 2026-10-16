import { describe, expect, it, vi } from "vitest";

const cryptoMock = vi.hoisted(() => ({ randomInt: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: (...args: unknown[]) => cryptoMock.randomInt(...args) ?? (actual.randomInt as (...a: unknown[]) => number)(...args) };
});

import { EMAIL_TOKEN_PATTERN } from "@/lib/validators/account";

import { generateEmailToken, generatePhoneCode } from "./secrets";

describe("generateEmailToken", () => {
  it("has 43 base64url characters and differs per call", () => {
    const [a, b] = [generateEmailToken(), generateEmailToken()];
    expect(a).toHaveLength(43);
    expect(a).toMatch(EMAIL_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });
});

describe("generatePhoneCode", () => {
  it("is 6 digits", () => {
    expect(generatePhoneCode()).toMatch(/^\d{6}$/);
  });

  it("pads with leading zeros", () => {
    cryptoMock.randomInt.mockReturnValueOnce(42);
    expect(generatePhoneCode()).toBe("000042");
  });
});
