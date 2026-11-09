import { describe, expect, it } from "vitest";

import { buildContactUpdate, isOwnResearch, missingThirdPartyEmail } from "./contact-rules";

describe("isOwnResearch", () => {
  it("true quando o documento digitado é o do Titular do comprador", () => {
    expect(isOwnResearch("123.456.789-09", "12345678909")).toBe(true);
  });
  it("false com outro documento, sem comprador ou vazio", () => {
    expect(isOwnResearch("11144477735", "12345678909")).toBe(false);
    expect(isOwnResearch("12345678909", null)).toBe(false);
    expect(isOwnResearch("", "")).toBe(false);
  });
});

describe("missingThirdPartyEmail", () => {
  it("exige e-mail só para terceiro", () => {
    expect(missingThirdPartyEmail(false, " ")).toBe(true);
    expect(missingThirdPartyEmail(false, "a@b.com")).toBe(false);
    expect(missingThirdPartyEmail(true, "")).toBe(false);
  });
});

describe("buildContactUpdate", () => {
  it("monta os campos da action e apara espaços", () => {
    expect(buildContactUpdate("d", "c", " a@b.com ", "")).toEqual({
      dossierId: "d",
      consultationId: "c",
      contactEmail: "a@b.com",
      contactPhone: "",
    });
  });
});
