import { describe, expect, it } from "vitest";

import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { adapt } from "@/lib/deps/adapter";
import { DEPS_PRODUCT_PF } from "@/lib/deps/products";
import { toConsultationContent } from "@/lib/consultations/full-view";
import type { CanonicalBureauResult } from "@/types/bureau";
import { renderCompleteConsultationPdf } from "./complete-consultation-document";

const LETTERHEAD = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const header = { name: "Maria Exemplo da Silva", cpf: "***.982.247-**", produto: "Smart PF", data: "19/10/2026", consultante: "Reino do Crédito", usuario: "u1" };

function canonical(body: unknown): CanonicalBureauResult {
  const r = adapt(body, { product: DEPS_PRODUCT_PF, httpStatus: 200, receivedAt: new Date("2026-10-19T00:00:00Z") });
  if (!r.ok) throw new Error(`fixture did not adapt: ${JSON.stringify(r.errors)}`);
  return r.value;
}

describe("renderCompleteConsultationPdf", () => {
  it("renders the full payload view", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, LETTERHEAD);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
  it("renders the canonical fallback when there is no payload", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(null, canonical(fixture)), header, LETTERHEAD);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});
