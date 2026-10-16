import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ getDossierDetail: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/actions/settings", () => ({ getAiPrompt: vi.fn() }));
vi.mock("@/lib/ai/opinion", () => ({ generateCompanyParecer: vi.fn() }));
vi.mock("@/lib/ai/prompt", () => ({ COMPANY_PROMPT_VERSION: "v" }));
vi.mock("@/lib/auth/session", () => ({
  getRequiredSession: vi.fn(async () => ({ userId: "u1", role: "operator", bureauId: "b1" })),
}));
vi.mock("@/lib/db/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/dossiers/queries", () => ({
  dossierCanonicalResults: vi.fn(),
  getDossierDetail: state.getDossierDetail,
  saveDossierReport: vi.fn(),
}));

import { generateDossierReport } from "./dossiers";

describe("id validation", () => {
  it("generateDossierReport returns an error for a non-uuid id", async () => {
    expect(await generateDossierReport("abc")).toEqual({ error: "Dossiê não encontrado." });
    expect(state.getDossierDetail).not.toHaveBeenCalled();
  });
});
