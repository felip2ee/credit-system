import { describe, expect, it } from "vitest";
import { maskDocument, maskDocumentValue, maskPayerDocument, maskPhone, maskPostalCode } from "./mask-document";

describe("maskDocument", () => {
  it("masks a CPF like order_mask_document", () => {
    expect(maskDocument("PF", "52998224725")).toBe("***.982.247-**");
  });
  it("masks a CNPJ like order_mask_document", () => {
    expect(maskDocument("PJ", "11222333000181")).toBe("**.222.333/0001-**");
  });
  it("returns a dash for a wrong length", () => {
    expect(maskDocument("PF", "123")).toBe("—");
  });
});

describe("maskDocumentValue", () => {
  it.each([
    ["52998224725", "***.982.247-**"],
    [52998224725, "***.982.247-**"],
    ["529.982.247-25", "***.982.247-**"],
    ["11222333000181", "**.222.333/0001-**"],
    ["123", "—"],
    [null, "—"],
    [{ a: 1 }, "—"],
  ])("maskDocumentValue(%j) is %s", (input, expected) => {
    expect(maskDocumentValue(input)).toBe(expected);
  });
});

describe("maskPayerDocument", () => {
  it("masks a CPF showing digits 4 to 6", () => {
    expect(maskPayerDocument("12345678909")).toBe("***.456.***-**");
  });
  it("masks a CNPJ showing digits 3 to 5", () => {
    expect(maskPayerDocument("12345678000195")).toBe("**.345.***/****-**");
  });
  it.each(["", "123", "123456789012", "abcdefghijk"])("returns a dash for %j", (value) => {
    expect(maskPayerDocument(value)).toBe("—");
  });
});

describe("maskPostalCode", () => {
  it("shows only the last 3 digits", () => {
    expect(maskPostalCode("01310678")).toBe("*****-678");
  });
  it.each(["", "0131067", "013106789", "abcdefgh"])("returns a dash for %j", (value) => {
    expect(maskPostalCode(value)).toBe("—");
  });
});

describe("maskPhone", () => {
  it("shows only the last 4 digits", () => {
    expect(maskPhone("+5511987654321")).toBe("(**) *****-4321");
  });
  it.each(["", "11987654321", "+123", "+55abc"])("returns a dash for %j", (value) => {
    expect(maskPhone(value)).toBe("—");
  });
});
