import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const DOSSIER_ID = "abcdef12-0000-4000-8000-0000000000d1";
const TX_CLIENT = { tx: true };

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	delivery: null as unknown,
	getMyDelivery: vi.fn(),
	render: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return { userId: USER_ID, role: state.role, bureauId: "b1", supportSessionId: null };
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work(TX_CLIENT),
}));
vi.mock("@/lib/orders/client-queries", () => ({ getMyDelivery: state.getMyDelivery }));
vi.mock("@/lib/pdf/letterhead", () => ({ letterheadDataUri: () => "data:image/png;base64,AAAA" }));
vi.mock("@/lib/pdf/dossier-document", () => ({ renderDossierPdf: state.render }));
vi.mock("@/lib/consultations/full-view", () => ({
	toConsultationContent: (payload: unknown, canonical: { name: string } | null) => ({
		full: payload ? { marker: "full", meta: [{ label: "Versão", value: "1" }] } : null,
		view: canonical ? { subject: { name: canonical.name, documentLabel: "CPF", location: null } } : null,
	}),
}));

import { GET } from "./route";

const call = (id = DOSSIER_ID) => GET(new Request("http://localhost/portal/pesquisas/x/pdf"), { params: { id } });

const delivery = (overrides: Record<string, unknown> = {}) => ({
	order: {
		dossierId: DOSSIER_ID,
		subjectName: "Maria Souza",
		subjectDocumentMasked: "***.533.447-**",
		createdAt: new Date("2026-10-01T12:00:00Z"),
		releasedAt: new Date("2026-10-02T12:00:00Z"),
	},
	kind: "PJ_FULL",
	members: [
		{ consultationId: "c2", type: "PF", name: "Sócio Um", product: null, status: "completed", canonical: { name: "Sócio Um", document: { type: "cpf", value: "39053344705" } }, payload: null, opinion: null },
		{ consultationId: "c1", type: "PJ", name: "Empresa X", product: "Dossiê PJ", status: "completed", canonical: { name: "Empresa X", document: { type: "cnpj", value: "11222333000181" } }, payload: null, opinion: null },
		{ consultationId: "c3", type: "PF", name: "Sem dado", product: null, status: "error", canonical: null, payload: null, opinion: null },
	],
	dossierOpinion: null,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.sessionError = null;
	state.getMyDelivery.mockResolvedValue(delivery());
	state.render.mockResolvedValue(Buffer.from("%PDF-1.4 test"));
});

describe("client pdf route", () => {
	it("returns 401 without a session", async () => {
		state.sessionError = new Error("no session");

		expect((await call()).status).toBe(401);
		expect(state.getMyDelivery).not.toHaveBeenCalled();
	});

	it.each(["operator", "bureau_admin", "superadmin"])("returns 403 for the %s role", async (role) => {
		state.role = role;

		expect((await call()).status).toBe(403);
		expect(state.getMyDelivery).not.toHaveBeenCalled();
	});

	it("returns 404 for an id that is not a uuid, without querying", async () => {
		expect((await call("abc")).status).toBe(404);
		expect(state.getMyDelivery).not.toHaveBeenCalled();
	});

	it("client pdf route returns 404 for another client or an unreleased order", async () => {
		state.getMyDelivery.mockResolvedValue(null);

		const response = await call();

		expect(response.status).toBe(404);
		expect(state.getMyDelivery).toHaveBeenCalledWith(TX_CLIENT, DOSSIER_ID);
		expect(state.render).not.toHaveBeenCalled();
	});

	it("returns 409 when no member has a result", async () => {
		state.getMyDelivery.mockResolvedValue(delivery({ members: [] }));

		const res = await call();
		expect(res.status).toBe(409);
		expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(await res.text()).toBe("A entrega ainda não tem resultado para gerar o PDF.");
		expect(state.render).not.toHaveBeenCalled();
	});

	it("returns the PDF as an attachment for a released order", async () => {
		const response = await call();

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/pdf");
		expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="pesquisa-abcdef12.pdf"');
		expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
		expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-1.4 test");
	});

	it("renders the company first, skips members without result and masks the dossier header", async () => {
		await call();

		const [data, letterhead] = state.render.mock.calls[0];
		expect(letterhead).toBe("data:image/png;base64,AAAA");
		expect(data.title).toBe("Maria Souza");
		expect(data.subtitle).toBe("***.533.447-** · 2 consulta(s)");
		expect(data.entries.map((e: { role: string }) => e.role)).toEqual(["Empresa", "Sócio"]);
		expect(data.report).toBeNull();
	});

	it("renders a completed member that has a payload but no canonical result, without the meta footer", async () => {
		state.getMyDelivery.mockResolvedValue(
			delivery({
				members: [
					{ consultationId: "c4", type: "PF", name: "Só payload", product: null, status: "completed", canonical: null, payload: { mix: {} }, opinion: null },
				],
			}),
		);
		await call();
		const [data] = state.render.mock.calls[0];
		expect(data.entries).toHaveLength(1);
		expect(data.entries[0].content).toEqual({ full: { marker: "full", meta: [] }, view: null });
		expect(data.entries[0].header.cpf).toBe("—");
	});

	it("skips a member that has a payload but is not completed", async () => {
		state.getMyDelivery.mockResolvedValue(
			delivery({
				members: [
					{ consultationId: "c4", type: "PF", name: "Incompatível", product: null, status: "payload_incompatible", canonical: null, payload: { mix: {} }, opinion: null },
				],
			}),
		);
		const res = await call();
		expect(res.status).toBe(409);
		expect(state.render).not.toHaveBeenCalled();
	});

	it("masks the document in each entry header", async () => {
		await call();
		const [data] = state.render.mock.calls[0];
		expect(data.entries.map((e: { header: { cpf: string } }) => e.header.cpf)).toEqual(["**.222.333/0001-**", "***.533.447-**"]);
	});

	it("passes the dossier opinion to the report block", async () => {
		state.getMyDelivery.mockResolvedValue(
			delivery({
				dossierOpinion: {
					apto: "apto_com_ressalvas",
					classificacao_perfil: "Bom",
					resumo_executivo: "Resumo",
					pontos_fortes: [],
					pontos_atencao: [],
					plano_acao: [],
					limite_sugerido: 1000,
					limite_sugerido_notas: "Nota",
					relatorio_markdown: "# Parecer",
				},
			}),
		);

		await call();

		expect(state.render.mock.calls[0][0].report).toMatchObject({
			aptitude: "apt_with_caveats",
			classificacao: "Bom",
			resumo: "Resumo",
			limiteSugerido: 1000,
			relatorioMarkdown: "# Parecer",
		});
	});
});
