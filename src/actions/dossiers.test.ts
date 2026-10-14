import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createDossierQuery: vi.fn(),
  getDossierMember: vi.fn(),
  getDossierDetail: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: state.revalidatePath }));
vi.mock("@/actions/settings", () => ({ getAiPrompt: vi.fn() }));
vi.mock("@/actions/consultations", () => ({}));
vi.mock("@/lib/ai/opinion", () => ({ generateCompanyParecer: vi.fn() }));
vi.mock("@/lib/ai/prompt", () => ({ COMPANY_PROMPT_VERSION: "v" }));
vi.mock("@/lib/auth/session", () => ({
  getRequiredSession: vi.fn(async () => ({ userId: "u1", role: "operator", bureauId: "b1" })),
}));
vi.mock("@/lib/db/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/db/transaction", () => ({ withUserTransaction: vi.fn() }));
vi.mock("@/lib/consultations/service", () => ({ executeConsultation: vi.fn() }));
vi.mock("@/lib/deps/client", () => ({ getDepsClient: vi.fn() }));
vi.mock("@/lib/deps/errors", () => ({ DepsScrPendingError: class extends Error {} }));
vi.mock("@/lib/deps/products", () => ({ depsProductName: vi.fn() }));
vi.mock("@/lib/scr/queries", () => ({ hasValidInternalScr: vi.fn(), upsertScrAuthorization: vi.fn() }));
vi.mock("@/lib/dossiers/queries", () => ({
  createDossier: state.createDossierQuery,
  dossierCanonicalResults: vi.fn(),
  getDossierDetail: state.getDossierDetail,
  getDossierMember: state.getDossierMember,
  refreshDossierStatus: vi.fn(),
  saveDossierReport: vi.fn(),
}));

import { createDossier, generateDossierReport, processDossierMember } from "./dossiers";

const CNPJ = "11.222.333/0001-81";
const CPF = "390.533.447-05";

beforeEach(() => {
  vi.clearAllMocks();
  state.createDossierQuery.mockResolvedValue({ ok: true, id: "d1", consultationIds: ["c1"] });
});

describe("createDossier", () => {
  it("rejects an unknown kind without touching the database", async () => {
    const result = await createDossier({ kind: "XX" as never, document: CNPJ });
    expect(result.error).toBe("Tipo de Dossiê inválido.");
    expect(state.createDossierQuery).not.toHaveBeenCalled();
  });

  it("rejects a partner percentage above 100", async () => {
    const result = await createDossier({
      kind: "PJ_FULL",
      document: CNPJ,
      partners: [{ cpf: CPF, percentage: 150 }],
    });
    expect(result.error).toBe("Participação do sócio deve estar entre 0 e 100.");
    expect(state.createDossierQuery).not.toHaveBeenCalled();
  });

  it("passes the validated digits to the query and revalidates the lists", async () => {
    const result = await createDossier({ kind: "PJ", document: CNPJ, name: " Empresa " });
    expect(result).toEqual({ error: null, dossierId: "d1", consultationIds: ["c1"] });
    expect(state.createDossierQuery.mock.calls[0][1]).toMatchObject({
      kind: "PJ",
      holder: { type: "PJ", name: "Empresa", document: "11222333000181" },
      scrMode: "internal",
    });
    expect(state.revalidatePath).toHaveBeenCalledWith("/dossiers");
  });
});

describe("id validation", () => {
  it("processDossierMember returns error for a non-uuid id", async () => {
    expect(await processDossierMember("abc")).toEqual({ outcome: "error" });
    expect(state.getDossierMember).not.toHaveBeenCalled();
  });

  it("generateDossierReport returns an error for a non-uuid id", async () => {
    expect(await generateDossierReport("abc")).toEqual({ error: "Dossiê não encontrado." });
    expect(state.getDossierDetail).not.toHaveBeenCalled();
  });
});
