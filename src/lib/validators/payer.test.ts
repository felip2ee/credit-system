import { describe, expect, it } from "vitest";

import { addressNumberSchema, cardFieldsSchema, cpfCnpjSchema, payerFieldsSchema, postalCodeSchema } from "./payer";

const VALID_CPF = "52998224725";
const VALID_CNPJ = "11222333000181";
const VISA = "4111111111111111";

describe("cpfCnpjSchema", () => {
  it("accepts a valid CPF and CNPJ, formatted or not, and returns digits", () => {
    expect(cpfCnpjSchema.parse(VALID_CPF)).toBe(VALID_CPF);
    expect(cpfCnpjSchema.parse("529.982.247-25")).toBe(VALID_CPF);
    expect(cpfCnpjSchema.parse("11.222.333/0001-81")).toBe(VALID_CNPJ);
  });

  it.each(["52998224726", "11222333000182", "11111111111", "00000000000000", "123", "", "5299822472512"])(
    "rejects %s",
    (value) => {
      expect(cpfCnpjSchema.safeParse(value).success).toBe(false);
    },
  );

  it("never echoes the value in the error", () => {
    const result = cpfCnpjSchema.safeParse("52998224726");
    expect(JSON.stringify(result.error?.issues)).not.toContain("52998224726");
  });
});

describe("postalCodeSchema", () => {
  it("accepts 8 digits, formatted or not", () => {
    expect(postalCodeSchema.parse("01310-100")).toBe("01310100");
    expect(postalCodeSchema.parse("01310100")).toBe("01310100");
  });
  it.each(["0131010", "013101000", "abcdefgh", ""])("rejects %s", (value) => {
    expect(postalCodeSchema.safeParse(value).success).toBe(false);
  });
});

describe("addressNumberSchema", () => {
  it.each(["1", "123", "12A", "S/N", "s/n", "1234567890"])("accepts %s", (value) => {
    expect(addressNumberSchema.safeParse(value).success).toBe(true);
  });
  it("normalizes s/n", () => {
    expect(addressNumberSchema.parse(" s/n ")).toBe("S/N");
  });
  it.each(["", "   ", "12345678901", "1;drop", "<b>"])("rejects %j", (value) => {
    expect(addressNumberSchema.safeParse(value).success).toBe(false);
  });
});

describe("payerFieldsSchema", () => {
  it("accepts an empty object (the matrix decides what is required)", () => {
    expect(payerFieldsSchema.parse({})).toEqual({});
  });

  it("parses and normalizes every field", () => {
    expect(
      payerFieldsSchema.parse({
        name: "  Maria Souza ",
        document: "529.982.247-25",
        email: " Maria@Example.COM ",
        phone: "+5511987654321",
        postalCode: "01310-100",
        addressNumber: "10",
      }),
    ).toEqual({
      name: "Maria Souza",
      document: VALID_CPF,
      email: "maria@example.com",
      phone: "+5511987654321",
      postalCode: "01310100",
      addressNumber: "10",
    });
  });

  it.each([
    [{ phone: "11987654321" }],
    [{ phone: "+0123456789" }],
    [{ phone: "+55 11 98765-4321" }],
    [{ email: "nope" }],
    [{ name: "A" }],
    [{ name: "x".repeat(121) }],
    [{ document: "123" }],
  ])("rejects %j", (input) => {
    expect(payerFieldsSchema.safeParse(input).success).toBe(false);
  });
});

describe("cardFieldsSchema", () => {
  const card = { number: VISA, holderName: "MARIA SOUZA", expiryMonth: "12", expiryYear: "2099", cvv: "123" };

  it("accepts a valid card and strips spaces and hyphens from the number", () => {
    expect(cardFieldsSchema.parse(card)).toEqual(card);
    expect(cardFieldsSchema.parse({ ...card, number: "4111 1111-1111 1111" }).number).toBe(VISA);
  });

  it("accepts 13 to 19 digit numbers that pass Luhn", () => {
    expect(cardFieldsSchema.safeParse({ ...card, number: "4222222222222" }).success).toBe(true); // 13
    expect(cardFieldsSchema.safeParse({ ...card, number: "6011000000000000001" }).success).toBe(true); // 19
  });

  it.each(["4111111111111112", "411111111111", "41111111111111111111", "abcdabcdabcdabcd", ""])(
    "rejects the number %s",
    (number) => {
      expect(cardFieldsSchema.safeParse({ ...card, number }).success).toBe(false);
    },
  );

  it.each(["00", "13", "1", "ab"])("rejects the month %s", (expiryMonth) => {
    expect(cardFieldsSchema.safeParse({ ...card, expiryMonth }).success).toBe(false);
  });

  it.each(["99", "20999", "abcd"])("rejects the year %s", (expiryYear) => {
    expect(cardFieldsSchema.safeParse({ ...card, expiryYear }).success).toBe(false);
  });

  it("rejects an expired card", () => {
    expect(cardFieldsSchema.safeParse({ ...card, expiryMonth: "01", expiryYear: "2020" }).success).toBe(false);
  });

  it.each(["12", "12345", "abc", ""])("rejects the CVV %j", (cvv) => {
    expect(cardFieldsSchema.safeParse({ ...card, cvv }).success).toBe(false);
  });

  it("accepts a 4 digit CVV", () => {
    expect(cardFieldsSchema.safeParse({ ...card, cvv: "1234" }).success).toBe(true);
  });

  it("rejects a short holder name", () => {
    expect(cardFieldsSchema.safeParse({ ...card, holderName: "A" }).success).toBe(false);
  });

  it("never echoes card data in error messages", () => {
    const result = cardFieldsSchema.safeParse({ ...card, number: "4111111111111112", cvv: "9" });
    const text = JSON.stringify(result.error?.issues);
    expect(text).not.toContain("4111111111111112");
    expect(text).not.toContain('"9"');
  });
});
