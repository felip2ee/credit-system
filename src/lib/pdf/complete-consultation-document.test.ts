import { inflateSync } from "node:zlib";
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

// Texto do PDF: infla cada stream Flate e junta os trechos hex dos operadores TJ (fonte padrão, bytes WinAnsi).
function pdfText(pdf: Buffer): string {
  const lines: string[] = [];
  for (const stream of Array.from(pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)endstream/g))) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(stream[1], "latin1")).toString("latin1");
    } catch {
      continue; // stream que não é Flate (imagem do timbrado)
    }
    for (const tj of Array.from(content.matchAll(/\[([^\]]*)\]\s*TJ/g))) {
      const hex = Array.from(tj[1].matchAll(/<([0-9a-f]*)>/gi)).map((h) => Buffer.from(h[1], "hex").toString("latin1"));
      lines.push(hex.join(""));
    }
  }
  return lines.join("\n");
}

describe("renderCompleteConsultationPdf", () => {
  it("prints the spec titles and the parts collapsed on screen", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, LETTERHEAD);
    const text = pdfText(pdf);
    for (const title of ["SCR", "Parecer Smart", "Renda presumida", "Histórico de classificação", "Todas as classificações"]) {
      expect(text, title).toContain(title);
    }
  }, 30_000);
  it("renders the full payload view", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, LETTERHEAD);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
  it("renders the canonical fallback when there is no payload", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(null, canonical(fixture)), header, LETTERHEAD);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});
