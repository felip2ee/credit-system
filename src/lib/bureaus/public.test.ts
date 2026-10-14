import { describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/pool", () => ({ pool: { query } }));

import { getPublicCatalog } from "@/lib/bureaus/public";

describe("getPublicCatalog", () => {
  it("returns [] for invalid slug without querying", async () => {
    expect(await getPublicCatalog("A!")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("maps sale_price to salePrice", async () => {
    query.mockResolvedValueOnce({
      rows: [{ code: "consulta_pf", name: "Consulta PF", kind: "main", sale_price: "12.50" }],
    });
    expect(await getPublicCatalog("meu-bureau")).toEqual([
      { code: "consulta_pf", name: "Consulta PF", kind: "main", salePrice: "12.50" },
    ]);
  });
});
