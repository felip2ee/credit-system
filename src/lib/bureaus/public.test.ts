import { describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/pool", () => ({ pool: { query } }));

import { getPublicCatalog } from "@/lib/bureaus/public";

describe("getPublicCatalog", () => {
  it("returns [] for invalid slug without querying", async () => {
    expect(await getPublicCatalog("A!")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("maps sale_price and sale_price_per_partner to camelCase", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          code: "dossie_empresarial",
          name: "Dossiê Empresarial",
          sale_price: "100.00",
          sale_price_per_partner: "30.00",
        },
      ],
    });
    expect(await getPublicCatalog("meu-bureau")).toEqual([
      {
        code: "dossie_empresarial",
        name: "Dossiê Empresarial",
        salePrice: "100.00",
        salePricePerPartner: "30.00",
      },
    ]);
  });
});
