import { describe, expect, it } from "vitest";

import { buildWhatsappUrl, maskDocument } from "./share-link";

describe("buildWhatsappUrl", () => {
  it("uses wa.me without phone and encodes the whole message, url included", () => {
    const url = "https://app.test/pagar/abc?x=1&y=2";
    const out = buildWhatsappUrl({ bureauName: "Bureau Ágil", productName: "Dossiê Pessoa Física", url });
    expect(out.startsWith("https://wa.me/?text=")).toBe(true);
    const text = decodeURIComponent(out.slice("https://wa.me/?text=".length));
    expect(text).toContain("Bureau Ágil");
    expect(text).toContain("Dossiê Pessoa Física");
    expect(text).toContain(url);
    expect(out).not.toContain("&y=2");
  });
});

describe("maskDocument", () => {
  it("never returns the full document", () => {
    expect(maskDocument("123.456.789-09")).toBe("***.456.789-**");
    expect(maskDocument("12345678000195")).toBe("**.***.***/0001-**");
    expect(maskDocument("123")).toBe("***");
  });
});
