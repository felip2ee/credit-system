import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  client: { query: vi.fn() },
  writeAuditEvent: vi.fn(),
  generateParecer: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/actions/settings", () => ({ getAiPrompt: vi.fn(async () => "prompt") }));
vi.mock("@/lib/ai/opinion", () => ({ generateParecer: state.generateParecer }));
vi.mock("@/lib/ai/prompt", () => ({ PROMPT_VERSION: "v-test" }));
vi.mock("@/lib/consultations/canonical-store", () => ({ loadCanonicalResult: vi.fn(async () => ({})) }));
vi.mock("@/lib/auth/session", () => ({
  getRequiredSession: vi.fn(async () => ({ userId: "u1", role: "operator", bureauId: "b1" })),
}));
vi.mock("@/lib/db/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/db/transaction", () => ({
  withUserTransaction: vi.fn(async (_identity, work) => work(state.client)),
}));
vi.mock("@/lib/holders/queries", () => ({ recordHolderEvent: vi.fn() }));
vi.mock("@/lib/audit/write", () => ({ writeAuditEvent: state.writeAuditEvent }));

import { generateOpinion } from "./ai";

const CONSULTATION_ID = "6f1c2c1e-0b6e-4b8e-9a53-3a0e2f6f4d11";

beforeEach(() => {
  vi.clearAllMocks();
  state.client.query.mockImplementation(async (sql: string) =>
    sql.includes("left join ai_reports")
      ? { rows: [{ id: CONSULTATION_ID, type: "PF", status: "completed", holder_id: "h1", document_name: "Maria", report_status: null }] }
      : { rows: [] },
  );
  state.generateParecer.mockResolvedValue({
    parecer: {
      apto: "apto",
      resumo_executivo: "r",
      pontos_fortes: [],
      pontos_atencao: [],
      plano_acao: [],
      produtos_sugeridos: [],
      limite_sugerido: 0,
      limite_sugerido_notas: "",
      relatorio_markdown: "m",
      classificacao_perfil: "Bom",
    },
    model: "modelo-teste",
  });
});

describe("generateOpinion audit", () => {
  it("writes ai.opinion in the same transaction as the ai_reports upsert", async () => {
    expect(await generateOpinion(CONSULTATION_ID)).toEqual({ error: null });
    expect(state.writeAuditEvent).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({
        actorId: "u1",
        action: "ai.opinion",
        targetTable: "consultations",
        targetId: CONSULTATION_ID,
        metadata: { model: "modelo-teste", promptVersion: "v-test" },
      }),
    );
  });

  it("writes a failure ai.opinion event when the generation throws", async () => {
    state.generateParecer.mockRejectedValue(new Error("falhou"));
    expect(await generateOpinion(CONSULTATION_ID)).toEqual({ error: "falhou" });
    expect(state.writeAuditEvent).toHaveBeenCalledWith(
      state.client,
      expect.objectContaining({ action: "ai.opinion", targetId: CONSULTATION_ID, outcome: "failure" }),
    );
  });
});
