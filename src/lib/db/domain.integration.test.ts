// Integração do domínio (Titular, Sociedade, Dossiê), settings, auditoria e dashboard
// contra um Postgres real, sob RLS. Dois Bureaus por teste (seedTenant) provam o isolamento.

import { randomInt } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system",
		BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
		BETTER_AUTH_URL: "http://localhost:3000",
		DOCUMENT_ROOT: "/tmp/reino-test-documents",
		CLAMAV_HOST: "localhost",
		CLAMAV_PORT: "3310",
		SMTP_HOST: "smtp.example.test",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USER: "credit-system",
		SMTP_PASS: "test-password",
	});
});

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { writeAuditEvent } from "@/lib/audit/write";
import { getDashboardMetrics } from "@/lib/dashboard/queries";
import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import {
	createDossier,
	getDossierDetail,
	listDossiers,
	saveDossierReport,
} from "@/lib/dossiers/queries";
import {
	createHolder,
	ensureHolder,
	getHolderDetail,
	linkPartner,
	listHolders,
	upsertPartnership,
	type HolderInput,
} from "@/lib/holders/queries";
import {
	deleteSettings,
	readSetting,
	upsertSettings,
} from "@/lib/settings/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	randomCpf,
	seedSuperadmin,
	seedTenant,
	type SeededTenant,
} from "@/test/seed";
import type { Parecer } from "@/types/ai";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 2 });

const digits = (length: number): string =>
	Array.from({ length }, () => randomInt(0, 10)).join("");
const randomCnpj = (): string => digits(14);
const onlyDigits = (value: string): string => value.replace(/\D/g, "");

const pfInput = (over: Partial<HolderInput> = {}): HolderInput => ({
	type: "PF",
	name: "Titular Integração",
	document: randomCpf(),
	...over,
});

const period = () => {
	const now = Date.now();
	const day = 86_400_000;
	return {
		startToday: new Date(now - day).toISOString(),
		startMonth: new Date(now - 30 * day).toISOString(),
		start6mo: new Date(now - 180 * day).toISOString(),
	};
};

const parecer: Parecer = {
	tipo_pessoa: "PJ",
	classificacao_perfil: "Bom",
	apto: "apto_com_ressalvas",
	resumo_executivo: "Resumo consolidado",
	notas: {
		cadastro: 7,
		score: 7,
		scr: 7,
		relacionamento_bancario: 7,
		capacidade_financeira: 7,
		garantias: 7,
		risco: 7,
		potencial_aprovacao: 7,
		final: 7,
	},
	fatores_decisivos: {
		maior_positivo: "a",
		maior_negativo: "b",
		prioritario_intervencao: "c",
	},
	pontos_fortes: [],
	pontos_atencao: [],
	plano_acao: [],
	produtos_sugeridos: [],
	top_oportunidades_imediatas: [],
	limite_sugerido: 1000,
	limite_sugerido_notas: "",
	dados_faltantes: [],
	relatorio_markdown: "# Parecer",
	disclaimer: "d",
};

let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
	a = await seedTenant(owner, "Domínio A");
	b = await seedTenant(owner, "Domínio B");
});

afterAll(async () => {
	try {
		await owner.end();
	} finally {
		await pool.end();
	}
});

describe.sequential("holders", () => {
	it("createHolder grava o Titular e o evento holder.created; duplicado no mesmo Bureau falha e no outro passa", async () => {
		const input = pfInput();
		const created = await createHolder(a.operator, input);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const detail = await getHolderDetail(a.operator, created.id);
		expect(detail?.holder.name).toBe("Titular Integração");
		expect(detail?.timeline.map((e) => e.event_type)).toContain(
			"holder.created",
		);

		const masked = await createHolder(a.operator, { ...input, name: "Outro" });
		expect(masked).toEqual({ ok: false, reason: "duplicate_document" });
		const unmasked = await createHolder(a.operator, {
			...input,
			document: onlyDigits(input.document),
		});
		expect(unmasked).toEqual({ ok: false, reason: "duplicate_document" });

		expect((await createHolder(b.operator, input)).ok).toBe(true);
	});

	it("listHolders devolve o e-mail do Titular para pré-preencher a consulta", async () => {
		const created = await createHolder(
			a.operator,
			pfInput({ email: "titular@example.test" }),
		);
		if (!created.ok) throw new Error("setup failed");
		const rows = await listHolders(a.operator, { q: "Titular Integração" });
		expect(rows.find((r) => r.id === created.id)?.email).toBe(
			"titular@example.test",
		);
	});

	it("upsertPartnership recusa empresa PF e auto-vínculo, e a segunda chamada atualiza o percentual sem duplicar", async () => {
		const { company, partner, pf } = await withUserTransaction(
			a.operator,
			async (client) => ({
				company: await ensureHolder(client, a.operator.userId, {
					type: "PJ",
					name: "Empresa Sociedade",
					document: randomCnpj(),
				}),
				partner: await ensureHolder(client, a.operator.userId, {
					type: "PF",
					name: "Sócio Sociedade",
					document: randomCpf(),
				}),
				pf: await ensureHolder(client, a.operator.userId, {
					type: "PF",
					name: "Outro PF",
					document: randomCpf(),
				}),
			}),
		);
		const link = (
			companyId: string,
			partnerId: string,
			percentage: number | null,
		) =>
			withUserTransaction(a.operator, (client) =>
				upsertPartnership(client, a.operator.userId, {
					companyId,
					partnerId,
					percentage,
					role: "Sócio",
					source: "operator",
				}),
			);

		expect(await link(pf, partner, 10)).toEqual({
			ok: false,
			reason: "company_not_pj",
		});
		expect(await link(company, company, 10)).toEqual({
			ok: false,
			reason: "self_link",
		});
		expect(await link(company, partner, 40)).toEqual({ ok: true });
		expect(await link(company, partner, 60)).toEqual({ ok: true });

		const detail = await getHolderDetail(a.operator, company);
		expect(detail?.partners).toHaveLength(1);
		expect(detail?.partners[0].percentage).toBe(60);
	});

	it("ensureHolder audita holder.create só quando insere, sem o documento completo", async () => {
		const cpf = onlyDigits(randomCpf());
		const run = () =>
			withUserTransaction(a.operator, (client) =>
				ensureHolder(client, a.operator.userId, {
					type: "PF",
					name: "Titular Auditado",
					document: cpf,
				}),
			);
		const id = await run();
		expect(await run()).toBe(id);

		const { rows } = await owner.query<{ metadata: Record<string, unknown> }>(
			"select metadata from audit_logs where action = 'holder.create' and record_id = $1",
			[id],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata.name).toBe("Titular Auditado");
		expect(JSON.stringify(rows[0].metadata)).not.toContain(cpf);
	});

	it("linkPartner com empresa PF devolve company_not_pj e não cria o Titular do sócio", async () => {
		const pf = await createHolder(a.operator, pfInput());
		if (!pf.ok) throw new Error("setup failed");
		const partnerCpf = onlyDigits(randomCpf());

		const result = await linkPartner(a.operator, pf.id, {
			document: partnerCpf,
			name: "Sócio Órfão",
			percentage: 10,
			role: null,
		});

		expect(result).toEqual({ ok: false, reason: "company_not_pj" });
		const { rowCount } = await owner.query(
			"select 1 from holders where document_digits = $1",
			[partnerCpf],
		);
		expect(rowCount).toBe(0);
	});

	it("dado da DEPS não sobrescreve a Sociedade informada pelo operador", async () => {
		const { company, partner } = await withUserTransaction(
			a.operator,
			async (client) => {
				const company = await ensureHolder(client, a.operator.userId, {
					type: "PJ",
					name: "Empresa Fonte",
					document: randomCnpj(),
				});
				const partner = await ensureHolder(client, a.operator.userId, {
					type: "PF",
					name: "Sócio Fonte",
					document: randomCpf(),
				});
				const base = { companyId: company, partnerId: partner, role: null };
				await upsertPartnership(client, a.operator.userId, {
					...base,
					percentage: 70,
					source: "operator",
				});
				await upsertPartnership(client, a.operator.userId, {
					...base,
					percentage: 10,
					source: "deps",
				});
				return { company, partner };
			},
		);
		const detail = await getHolderDetail(a.operator, company);
		expect(detail?.partners.find((p) => p.holder_id === partner)).toMatchObject(
			{ percentage: 70, source: "operator" },
		);
	});
});

describe.sequential("dossiers", () => {
	it("createDossier PJ_FULL cria empresa e sócios, reusa o sócio existente e cria uma consulta por membro", async () => {
		const existingCpf = randomCpf();
		const existing = await createHolder(
			a.operator,
			pfInput({ document: existingCpf, name: "Sócio Existente" }),
		);
		if (!existing.ok) throw new Error("setup failed");

		const cnpj = randomCnpj();
		const created = await createDossier(a.operator, {
			kind: "PJ_FULL",
			holder: { type: "PJ", name: "Empresa Cheia", document: cnpj },
			partners: [
				{
					document: existingCpf,
					name: "Nome Ignorado",
					email: null,
					percentage: 50,
					role: "Sócio",
				},
				{
					document: randomCpf(),
					name: "Sócio Novo",
					email: "novo@example.test",
					percentage: 50,
					role: "Administrador",
				},
			],
			scrMode: "internal",
			email: "empresa@example.test",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.consultationIds).toHaveLength(3);

		const company = await owner.query<{ id: string }>(
			"select id from holders where bureau_id = $1 and document_digits = $2",
			[a.bureau.id, cnpj],
		);
		const detail = await getHolderDetail(a.operator, company.rows[0].id);
		expect(detail?.partners).toHaveLength(2);
		expect(detail?.partners.map((p) => p.holder_id)).toContain(existing.id);
		expect(detail?.partners.every((p) => p.source === "operator")).toBe(true);
		expect(detail?.dossiers[0]).toMatchObject({
			kind: "PJ_FULL",
			report_status: "none",
		});

		const products = await owner.query<{ product: string; type: string }>(
			"select product, type::text from consultations where dossier_id = $1 order by type",
			[created.id],
		);
		expect(products.rows.map((r) => r.type)).toEqual(["PF", "PF", "PJ"]);
		expect(
			new Set(
				products.rows.filter((r) => r.type === "PF").map((r) => r.product),
			).size,
		).toBe(1);

		const sameHolder = await owner.query(
			"select 1 from holders where bureau_id = $1 and document_digits = $2",
			[a.bureau.id, onlyDigits(existingCpf)],
		);
		expect(sameHolder.rowCount).toBe(1);
	});

	it("createDossier PF com Titular PJ devolve kind_mismatch e não grava nada", async () => {
		const cnpj = randomCnpj();
		const result = await createDossier(a.operator, {
			kind: "PF",
			holder: { type: "PJ", name: "Empresa Errada", document: cnpj },
			scrMode: "internal",
		});
		expect(result).toEqual({ ok: false, reason: "kind_mismatch" });
		const rows = await owner.query(
			"select 1 from holders where document_digits = $1",
			[cnpj],
		);
		expect(rows.rowCount).toBe(0);
	});

	it("listDossiers filtra por tipo, devolve os membros e não mostra o outro Bureau", async () => {
		const pf = await createDossier(a.operator, {
			kind: "PF",
			holder: { type: "PF", name: "Pessoa Lista", document: randomCpf() },
			scrMode: "deps",
		});
		const bDossier = await createDossier(b.operator, {
			kind: "PF",
			holder: { type: "PF", name: "Pessoa Lista B", document: randomCpf() },
			scrMode: "deps",
		});
		if (!pf.ok || !bDossier.ok) throw new Error("setup failed");

		const onlyPf = await listDossiers(a.operator, { kind: "PF" });
		expect(onlyPf.length).toBeGreaterThan(0);
		expect(onlyPf.every((d) => d.kind === "PF")).toBe(true);
		expect(onlyPf.find((d) => d.id === pf.id)?.members).toHaveLength(1);
		expect(onlyPf.some((d) => d.id === bDossier.id)).toBe(false);

		const full = await listDossiers(a.operator, { kind: "PJ_FULL" });
		expect(full.every((d) => d.kind === "PJ_FULL")).toBe(true);
	});

	it("getHolderDetail PF lista as empresas em que é sócio", async () => {
		const partnerCpf = randomCpf();
		const created = await createDossier(a.operator, {
			kind: "PJ_FULL",
			holder: { type: "PJ", name: "Empresa do Sócio", document: randomCnpj() },
			partners: [
				{
					document: partnerCpf,
					name: "Sócia",
					email: null,
					percentage: 100,
					role: null,
				},
			],
			scrMode: "deps",
		});
		if (!created.ok) throw new Error("setup failed");

		const partner = await owner.query<{ id: string }>(
			"select id from holders where bureau_id = $1 and document_digits = $2",
			[a.bureau.id, onlyDigits(partnerCpf)],
		);
		const detail = await getHolderDetail(a.operator, partner.rows[0].id);
		expect(detail?.companies.map((c) => c.name)).toEqual(["Empresa do Sócio"]);
	});

	it("saveDossierReport grava o parecer consolidado e getDossierDetail o devolve", async () => {
		const created = await createDossier(a.operator, {
			kind: "PJ",
			holder: { type: "PJ", name: "Empresa Parecer", document: randomCnpj() },
			scrMode: "deps",
		});
		if (!created.ok) throw new Error("setup failed");
		expect((await getDossierDetail(a.operator, created.id))?.report).toBeNull();

		await saveDossierReport(a.operator, created.id, {
			status: "completed",
			parecer,
			model: "modelo-teste",
			promptVersion: "v-teste",
		});
		const detail = await getDossierDetail(a.operator, created.id);
		expect(detail?.report).toMatchObject({
			status: "completed",
			aptitude_status: "apt_with_caveats",
			model_used: "modelo-teste",
		});
		expect(detail?.report?.full_report?.resumo_executivo).toBe(
			"Resumo consolidado",
		);
		expect(await getDossierDetail(b.operator, created.id)).toBeNull();

		const { rows } = await owner.query<{ outcome: string; metadata: Record<string, unknown> }>(
			"select outcome, metadata from audit_logs where action = 'dossier.report' and record_id = $1",
			[created.id],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			outcome: "success",
			metadata: { model: "modelo-teste", promptVersion: "v-teste" },
		});
	});

	it("saveDossierReport com erro audita dossier.report como failure", async () => {
		const created = await createDossier(a.operator, {
			kind: "PJ",
			holder: { type: "PJ", name: "Empresa Falha", document: randomCnpj() },
			scrMode: "deps",
		});
		if (!created.ok) throw new Error("setup failed");

		await saveDossierReport(a.operator, created.id, { status: "error", error: "falhou" });

		const { rows } = await owner.query<{ outcome: string }>(
			"select outcome from audit_logs where action = 'dossier.report' and record_id = $1",
			[created.id],
		);
		expect(rows).toEqual([{ outcome: "failure" }]);
	});

	it("createDossier audita holder.create do Titular novo, sem o documento completo", async () => {
		const cnpj = randomCnpj();
		const created = await createDossier(a.operator, {
			kind: "PJ",
			holder: { type: "PJ", name: "Empresa Auditada", document: cnpj },
			scrMode: "deps",
		});
		if (!created.ok) throw new Error("setup failed");

		const { rows } = await owner.query<{ metadata: Record<string, unknown> }>(
			`select a.metadata from audit_logs a join holders h on h.id = a.record_id
        where a.action = 'holder.create' and h.document_digits = $1`,
			[cnpj],
		);
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0].metadata)).not.toContain(cnpj);
	});
});

describe.sequential("settings, auditoria e dashboard", () => {
	it("upsertSettings como superadmin grava e como operador falha", async () => {
		const superadmin = await seedSuperadmin(owner);
		const key = `test_setting_${Date.now()}`;

		await upsertSettings(superadmin, [{ key, value: 7.5 }], "settings.update");
		expect(await readSetting(a.operator, key)).toBe(7.5);

		await expect(
			upsertSettings(a.operator, [{ key, value: 1 }], "settings.update"),
		).rejects.toThrow();
		expect(await readSetting(a.operator, key)).toBe(7.5);

		await deleteSettings(superadmin, [key], "settings.reset");
		expect(await readSetting(a.operator, key)).toBeNull();
	});

	it("writeAuditEvent grava o bureau_id da identidade e redige o documento", async () => {
		const actor = a.operator;
		await withUserTransaction(actor, (client) =>
			writeAuditEvent(client, {
				actorId: actor.userId,
				action: "holder.create",
				targetTable: "holders",
				targetId: a.holder.id,
				metadata: { document: "39053344705", name: "keep" },
			}),
		);

		const { rows } = await owner.query<{
			bureau_id: string;
			metadata: Record<string, unknown>;
		}>(
			"select bureau_id, metadata from audit_logs where user_id = $1 and action = 'holder.create' order by created_at desc limit 1",
			[actor.userId],
		);
		expect(rows[0].bureau_id).toBe(a.bureau.id);
		expect(JSON.stringify(rows[0].metadata)).not.toContain("39053344705");
		expect(rows[0].metadata.name).toBe("keep");
	});

	it("getDashboardMetrics conta só o próprio Bureau", async () => {
		const solo = await seedTenant(owner, "Dashboard solo");
		const before = await getDashboardMetrics(solo.operator, period());
		expect(before.counts.holders).toBe(1); // o Titular do seed

		const created = await createDossier(solo.operator, {
			kind: "PF",
			holder: { type: "PF", name: "Pessoa Métrica", document: randomCpf() },
			scrMode: "deps",
		});
		if (!created.ok) throw new Error("setup failed");

		const after = await getDashboardMetrics(solo.operator, period());
		expect(after.counts.holders).toBe(2);
		expect(after.counts.dossiersProcessing).toBe(1);
		expect(after.counts.month).toBe(1);
	});
});
