import { describe, expect, it } from "vitest";

import { auditActionLabel, describeAuditMetadata } from "@/lib/audit/labels";

describe("auditActionLabel", () => {
  it("traduz código conhecido e mantém o bruto", () => {
    expect(auditActionLabel("order.open")).toEqual({
      label: "Pedido aberto",
      raw: "order.open",
      known: true,
    });
  });

  it("devolve o código bruto quando desconhecido", () => {
    expect(auditActionLabel("foo.bar")).toEqual({
      label: "foo.bar",
      raw: "foo.bar",
      known: false,
    });
  });
});

describe("describeAuditMetadata", () => {
  it("rotula chaves comuns e oculta sensíveis e objetos", () => {
    expect(
      describeAuditMetadata({
        role: "operator",
        document: "***05",
        token: "abc",
        nested: { a: 1 },
        keys: ["a", "b"],
      }),
    ).toEqual(["Perfil: operator", "Itens: a, b"]);
  });

  it("aceita metadados vazios", () => {
    expect(describeAuditMetadata(null)).toEqual([]);
  });
});
