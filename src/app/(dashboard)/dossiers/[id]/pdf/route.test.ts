import { beforeEach, describe, expect, it, vi } from "vitest";

const DOSSIER_ID = "abcdef12-0000-4000-8000-0000000000d1";

const state = vi.hoisted(() => ({
	detail: null as unknown,
	reportRow: null as unknown,
	getConsultationReport: vi.fn(),
	render: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => ({ userId: "u1", role: "operator", bureauId: "b1", supportSessionId: null })),
}));
vi.mock("@/lib/db/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/dossiers/queries", () => ({ getDossierPdfDetail: vi.fn(async () => state.detail) }));
vi.mock("@/lib/consultations/queries", () => ({ getConsultationReport: state.getConsultationReport }));
vi.mock("@/lib/consultations/canonical-store", () => ({
	loadLatestPayload: async () => ({ mix: {} }),
	loadCanonicalResult: async () => null,
}));
vi.mock("@/lib/consultations/full-view", () => ({
	toConsultationContent: () => ({ full: { marker: "full", meta: [] }, view: null }),
}));
vi.mock("@/lib/bureaus/queries", () => ({ getOwnBureauName: async () => "Bureau Exemplo" }));
vi.mock("@/lib/config", () => ({ config: { supportEmail: "suporte@rainhacred.com.br" } }));
vi.mock("@/lib/pdf/dossier-document", () => ({ renderDossierPdf: state.render }));

import { GET } from "./route";

const call = () => GET(new Request("http://localhost/dossiers/x/pdf"), { params: { id: DOSSIER_ID } });

const member = (id: string, type: "PF" | "PJ") => ({
	id,
	type,
	document: type === "PJ" ? "11222333000181" : "39053344705",
	document_name: type === "PJ" ? "Empresa X" : "Maria",
	product: null,
	status: "completed",
	consulted_at: "2026-10-01T12:00:00Z",
	created_at: "2026-10-01T12:00:00Z",
	scr_email: null,
});

const detail = (kind: "PF" | "PJ" | "PJ_FULL", members: unknown[], report: unknown = null) => ({
	dossier: { id: DOSSIER_ID, kind, holder_name: "Maria", holder_document: "39053344705" },
	members,
	report,
});

const aiRow = {
	status: "completed",
	aptitude_status: "apt",
	full_report: { classificacao_perfil: "Ótimo" },
	executive_summary: "Resumo IA",
	positive_points: [{ title: "F", description: "f" }],
	risk_points: [{ title: "R", description: "r" }],
	action_plan: [{ step: "1", description: "p" }],
	suggested_limit: "2000.00",
	suggested_limit_notes: "Nota",
	model_used: "m",
	report_markdown: "# Parecer IA",
};

beforeEach(() => {
	vi.clearAllMocks();
	state.getConsultationReport.mockResolvedValue(null);
	state.render.mockResolvedValue(Buffer.from("%PDF-1.4 test"));
});

describe("staff dossier pdf route opinion", () => {
	it("uses the ai_reports opinion of a PF dossier that has no consolidated report", async () => {
		state.detail = detail("PF", [member("c1", "PF")]);
		state.getConsultationReport.mockResolvedValue(aiRow);

		const res = await call();

		expect(res.status).toBe(200);
		expect(state.getConsultationReport).toHaveBeenCalledWith(expect.anything(), "c1");
		expect(state.render.mock.calls[0][0].report).toEqual({
			aptitude: "apt",
			classificacao: "Ótimo",
			resumo: "Resumo IA",
			pontosFortes: [{ title: "F", description: "f" }],
			pontosAtencao: [{ title: "R", description: "r" }],
			planoAcao: [{ step: "1", description: "p" }],
			limiteSugerido: 2000,
			limiteNotas: "Nota",
			modelo: "m",
			relatorioMarkdown: "# Parecer IA",
		});
	});

	it("keeps the consolidated dossier report for PJ_FULL and does not read ai_reports", async () => {
		state.detail = detail("PJ_FULL", [member("c2", "PF"), member("c1", "PJ")], {
			status: "completed",
			aptitude_status: "apt_with_caveats",
			generation_error: null,
			report_markdown: "# Consolidado",
			full_report: {
				classificacao_perfil: "Bom",
				resumo_executivo: "Resumo consolidado",
				pontos_fortes: [{ title: "F", description: "f" }],
				pontos_atencao: [{ title: "R", description: "r" }],
				plano_acao: [{ step: "1", description: "p" }],
				limite_sugerido: 5000,
				limite_sugerido_notas: "Nota",
			},
			model_used: "m2",
			generated_at: null,
		});

		await call();

		expect(state.getConsultationReport).not.toHaveBeenCalled();
		expect(state.render.mock.calls[0][0].report).toMatchObject({
			aptitude: "apt_with_caveats",
			classificacao: "Bom",
			resumo: "Resumo consolidado",
			relatorioMarkdown: "# Consolidado",
			pontosFortes: [{ title: "F", description: "f" }],
			pontosAtencao: [{ title: "R", description: "r" }],
			planoAcao: [{ step: "1", description: "p" }],
			limiteSugerido: 5000,
			limiteNotas: "Nota",
		});
	});

	it("falls back to the company opinion when the PJ_FULL report is not completed", async () => {
		state.detail = detail("PJ_FULL", [member("c2", "PF"), member("c1", "PJ")], { status: "failed" });
		state.getConsultationReport.mockResolvedValue(aiRow);

		await call();

		expect(state.getConsultationReport).toHaveBeenCalledWith(expect.anything(), "c1");
		expect(state.render.mock.calls[0][0].report).toMatchObject({ resumo: "Resumo IA" });
	});

	it("does not use a partner opinion as the group opinion when the company is not in the dossier", async () => {
		state.detail = detail("PJ_FULL", [member("c2", "PF")], { status: "failed" });
		state.getConsultationReport.mockResolvedValue(aiRow);

		await call();

		expect(state.getConsultationReport).not.toHaveBeenCalled();
		expect(state.render.mock.calls[0][0].report).toBeNull();
	});

	it("renders without opinion when none exists", async () => {
		state.detail = detail("PF", [member("c1", "PF")]);

		const res = await call();

		expect(res.status).toBe(200);
		expect(state.render.mock.calls[0][0].report).toBeNull();
	});

	it("ignores an ai_reports opinion that is not completed", async () => {
		state.detail = detail("PF", [member("c1", "PF")]);
		state.getConsultationReport.mockResolvedValue({ ...aiRow, status: "failed" });

		await call();

		expect(state.render.mock.calls[0][0].report).toBeNull();
	});

	it("names the file by dossier id, never by the holder document", async () => {
		state.detail = detail("PF", [member("c1", "PF")]);

		const res = await call();

		expect(res.headers.get("Content-Disposition")).toBe('inline; filename="pesquisa-abcdef12.pdf"');
	});
});
