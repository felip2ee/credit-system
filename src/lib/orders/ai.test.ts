import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
	client: { query: vi.fn() },
	generateParecer: vi.fn(),
	generateCompanyParecer: vi.fn(),
	saveConsultationOpinion: vi.fn(),
	saveDossierReport: vi.fn(),
	dossierCanonicalResults: vi.fn(),
	loadCanonicalResult: vi.fn(),
	loadLatestPayload: vi.fn(),
	readAiPrompt: vi.fn(),
	getExecutionPlan: vi.fn(),
}));

vi.mock("@/lib/db/transaction", () => ({ withUserTransaction: async (_i: unknown, work: (c: unknown) => unknown) => work(s.client) }));
vi.mock("@/lib/ai/opinion", () => ({ generateParecer: s.generateParecer, generateCompanyParecer: s.generateCompanyParecer }));
vi.mock("@/lib/ai/persist", () => ({ saveConsultationOpinion: s.saveConsultationOpinion }));
vi.mock("@/lib/ai/prompt", () => ({ COMPANY_PROMPT_VERSION: "empresa-test" }));
vi.mock("@/lib/dossiers/queries", () => ({ saveDossierReport: s.saveDossierReport, dossierCanonicalResults: s.dossierCanonicalResults }));
vi.mock("@/lib/consultations/canonical-store", () => ({ loadCanonicalResult: s.loadCanonicalResult, loadLatestPayload: s.loadLatestPayload }));
vi.mock("@/lib/settings/readers", () => ({ readAiPrompt: s.readAiPrompt }));
vi.mock("./queries", () => ({ getExecutionPlan: s.getExecutionPlan }));

import { generateOrderAi } from "./ai";

const identity = { userId: "sys", role: "operator" as const, bureauId: "b1" };
const parecer = { apto: "apto" };
const main = { consultationId: "c1", type: "PF", holderId: "h1", name: "Maria", status: "completed", isMain: true };

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	s.readAiPrompt.mockResolvedValue("prompt");
	s.getExecutionPlan.mockResolvedValue({ members: [main] });
	s.loadCanonicalResult.mockResolvedValue({ canonico: true });
	s.loadLatestPayload.mockResolvedValue({ bruto: true });
	s.generateParecer.mockResolvedValue({ parecer, model: "m" });
	s.generateCompanyParecer.mockResolvedValue({ parecer, model: "m" });
});

describe("generateOrderAi", () => {
	it("PF generates the opinion from the main canonical result and saves it", async () => {
		expect(await generateOrderAi(identity, "d1", "PF")).toBe("done");

		expect(s.readAiPrompt).toHaveBeenCalledWith(identity, "pf");
		expect(s.generateParecer).toHaveBeenCalledWith({ type: "PF", dataAnalise: expect.any(String), canonical: { canonico: true }, payload: { bruto: true } }, "prompt");
		expect(s.saveConsultationOpinion).toHaveBeenCalledWith(
			s.client,
			identity,
			"c1",
			"h1",
			{ status: "completed", parecer, model: "m", documentName: "Maria" },
		);
		expect(s.generateCompanyParecer).not.toHaveBeenCalled();
	});

	it("PJ uses the pj prompt", async () => {
		s.getExecutionPlan.mockResolvedValue({ members: [{ ...main, type: "PJ" }] });

		await generateOrderAi(identity, "d1", "PJ");

		expect(s.readAiPrompt).toHaveBeenCalledWith(identity, "pj");
	});

	it("complete PJ generates the group report with the company and the completed partners", async () => {
		s.dossierCanonicalResults.mockResolvedValue([
			{ type: "PJ", canonical_result: { empresa: 1 }, payload: { p: 1 } },
			{ type: "PF", canonical_result: { socio: 1 }, payload: { p: 2 } },
			{ type: "PF", canonical_result: { socio: 2 }, payload: { p: 3 } },
		]);

		expect(await generateOrderAi(identity, "d1", "PJ_FULL")).toBe("done");

		expect(s.readAiPrompt).toHaveBeenCalledWith(identity, "empresa");
		expect(s.generateCompanyParecer).toHaveBeenCalledWith(
			{
				dataAnalise: expect.any(String),
				empresaRow: { empresa: 1 },
				empresaPayload: { p: 1 },
				socios: [
					{ type: "PF", resultRow: { socio: 1 }, payload: { p: 2 } },
					{ type: "PF", resultRow: { socio: 2 }, payload: { p: 3 } },
				],
			},
			"prompt",
		);
		expect(s.saveDossierReport).toHaveBeenCalledWith(identity, "d1", {
			status: "completed",
			parecer,
			model: "m",
			promptVersion: "empresa-test",
		});
		expect(s.generateParecer).not.toHaveBeenCalled();
	});

	it.each([
		["the model call throws", () => s.generateParecer.mockRejectedValue(new Error("12345678909 no corpo"))],
		["the canonical result is missing", () => s.loadCanonicalResult.mockResolvedValue(null)],
		["the main consultation is not completed", () => s.getExecutionPlan.mockResolvedValue({ members: [{ ...main, status: "error" }] })],
	])("returns failed without saving or logging content when %s", async (_name, arrange) => {
		arrange();

		expect(await generateOrderAi(identity, "d1", "PF")).toBe("failed");

		expect(s.saveConsultationOpinion).not.toHaveBeenCalled();
		expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("12345678909");
	});

	it("complete PJ without a completed company returns failed", async () => {
		s.dossierCanonicalResults.mockResolvedValue([{ type: "PF", canonical_result: {} }]);

		expect(await generateOrderAi(identity, "d1", "PJ_FULL")).toBe("failed");
		expect(s.saveDossierReport).not.toHaveBeenCalled();
	});
});
