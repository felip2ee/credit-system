import { describe, expect, it } from "vitest";
import { maskDocument, maskDocumentValue } from "./mask-document";

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
