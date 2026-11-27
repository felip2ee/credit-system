import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { BureauAffiliate } from "@/lib/affiliates/rates";

// O diálogo importa Server Actions (config do servidor): fora do escopo deste teste.
vi.mock("@/components/affiliates/affiliate-payout-dialog", () => ({ AffiliatePayoutDialog: () => null }));

import { BureauAffiliatesTable } from "./bureau-affiliates-table";

const row = (reversalFailed: string): BureauAffiliate => ({
  profileId: "p1",
  name: "Ana",
  code: "ANA1",
  referrals: 1,
  totalCommission: "15.83",
  reversalFailed,
  payoutMethod: "asaas",
  walletIdMasked: null,
});
const render = (a: BureauAffiliate) => renderToStaticMarkup(createElement(BureauAffiliatesTable, { defaultPct: "10", affiliates: [a] }));

describe("BureauAffiliatesTable", () => {
  it("mostra a nota de estorno sem devolução só quando existe", () => {
    expect(render(row("2.50"))).toMatch(/Inclui.*R\$.*2,50.* de repasses estornados sem devolução/);
    expect(render(row("0.00"))).not.toContain("estornados");
  });
});
