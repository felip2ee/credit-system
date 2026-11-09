// Dossiê: agrupa as consultas de um Titular (PF, PJ) ou da empresa e dos sócios (PJ_FULL).
// Leituras, parecer consolidado e status calculado. A abertura do Dossiê é o pedido (orders/queries.ts).

import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { OrderState } from "@/lib/orders/types";
import { toAptitudeStatus, type Parecer } from "@/types/ai";
import type { CanonicalBureauResult } from "@/types/bureau";
import type {
	DossierKind,
	DossierStatus,
	EntityKind,
	QueryStatus,
} from "@/types/app";

export type DossierKindFilter = DossierKind;

// Status do Dossiê a partir das consultas: processando até todas terminarem.
export async function refreshDossierStatus(
	client: PoolClient,
	dossierId: string,
): Promise<void> {
	await client.query(
		`update dossiers d set
       status = case
         when s.done < s.total then 'processing'
         when s.errors > 0 then 'completed_with_errors'
         else 'completed' end::dossier_status,
       completed_at = case when s.done >= s.total then now() end
     from (select count(*)::int as total,
                  count(*) filter (where status in ('completed', 'error', 'payload_incompatible'))::int as done,
                  count(*) filter (where status in ('error', 'payload_incompatible'))::int as errors
             from consultations where dossier_id = $1) s
     where d.id = $1 and d.status <> 'cancelled' and s.total > 0`,
		[dossierId],
	);
}

// ── Leituras ─────────────────────────────────────────────────────────────

export interface DossierMember {
	id: string;
	type: EntityKind;
	document: string;
	document_name: string | null;
	product: string | null;
	status: QueryStatus;
	consulted_at: string | null;
	created_at: string;
	// Só para a equipe, mascarado antes de chegar ao cliente do navegador.
	scr_email: string | null;
}

export interface DossierListItem {
	id: string;
	kind: DossierKind;
	status: DossierStatus;
	report_status: string;
	aptitude_status: string;
	created_at: string;
	holder_id: string;
	holder_name: string;
	holder_document: string;
	// Nulo nos Dossiês anteriores ao pedido de pesquisa.
	order_state: OrderState | null;
	members: Pick<
		DossierMember,
		"id" | "type" | "document" | "document_name" | "status"
	>[];
}

const LIST_LIMIT = 100;

export async function listDossiers(
	identity: DbIdentity,
	filters: { kind?: DossierKindFilter; q?: string },
): Promise<DossierListItem[]> {
	const term = filters.q?.trim() ?? "";
	const digits = term.replace(/\D/g, "");
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<DossierListItem>(
			`select d.id, d.kind::text, d.status::text, d.report_status, d.aptitude_status,
              d.created_at::text, h.id as holder_id, h.name as holder_name,
              h.document as holder_document, o.state::text as order_state,
              coalesce(jsonb_agg(jsonb_build_object(
                'id', c.id, 'type', c.type, 'document', c.document,
                'document_name', c.document_name, 'status', c.status::text)
                order by c.created_at) filter (where c.id is not null), '[]'::jsonb) as members
         from dossiers d
         join holders h on h.id = d.holder_id
         left join dossier_orders o on o.dossier_id = d.id
         left join consultations c on c.dossier_id = d.id
        where ($1::dossier_kind is null or d.kind = $1::dossier_kind)
          and ($2 = '' or h.name ilike '%' || $2 || '%'
               or ($3 <> '' and h.document_digits like '%' || $3 || '%'))
        group by d.id, h.id, o.state
        order by d.created_at desc
        limit ${LIST_LIMIT}`,
			[filters.kind ?? null, term, digits],
		);
		return rows;
	});
}

export interface DossierReportView {
	status: string;
	aptitude_status: string;
	generation_error: string | null;
	report_markdown: string | null;
	full_report: Parecer | null;
	model_used: string | null;
	generated_at: string | null;
}

export interface DossierDetail {
	dossier: Omit<DossierListItem, "members" | "order_state"> & {
		product: string;
		started_at: string | null;
		completed_at: string | null;
	};
	members: DossierMember[];
	report: DossierReportView | null; // nulo enquanto report_status = 'none'
}

async function loadDossierDetail(
	identity: DbIdentity,
	id: string,
	onlyCompleted: boolean,
): Promise<DossierDetail | null> {
	return withUserTransaction(identity, async (client) => {
		const dossier = await client.query<
			DossierDetail["dossier"] & DossierReportView & { report_status: string }
		>(
			`select d.id, d.kind::text, d.status::text, d.report_status, d.aptitude_status, d.product,
              d.created_at::text, d.started_at::text, d.completed_at::text,
              h.id as holder_id, h.name as holder_name, h.document as holder_document,
              d.report_status as status, d.generation_error, d.report_markdown, d.full_report,
              d.model_used, d.generated_at::text
         from dossiers d join holders h on h.id = d.holder_id
        where d.id = $1`,
			[id],
		);
		const row = dossier.rows[0];
		if (!row) return null;

		const members = await client.query<DossierMember>(
			`select id, type, document, document_name, product, status::text, consulted_at::text,
              created_at::text, scr_email
         from consultations
        where dossier_id = $1 ${onlyCompleted ? "and status = 'completed'" : ""}
        order by type, created_at`,
			[id],
		);
		const report: DossierReportView | null =
			row.report_status === "none"
				? null
				: {
						status: row.report_status,
						aptitude_status: row.aptitude_status,
						generation_error: row.generation_error,
						report_markdown: row.report_markdown,
						full_report: row.full_report,
						model_used: row.model_used,
						generated_at: row.generated_at,
					};
		return {
			dossier: {
				id: row.id,
				kind: row.kind,
				status: row.status as DossierStatus,
				report_status: row.report_status,
				aptitude_status: row.aptitude_status,
				product: row.product,
				created_at: row.created_at,
				started_at: row.started_at,
				completed_at: row.completed_at,
				holder_id: row.holder_id,
				holder_name: row.holder_name,
				holder_document: row.holder_document,
			},
			members: members.rows,
			report,
		};
	});
}

export const getDossierDetail = (
	identity: DbIdentity,
	id: string,
): Promise<DossierDetail | null> => loadDossierDetail(identity, id, false);

// PDF: só os membros concluídos entram.
export const getDossierPdfDetail = (
	identity: DbIdentity,
	id: string,
): Promise<DossierDetail | null> => loadDossierDetail(identity, id, true);

export type DossierReport =
	| {
			status: "completed";
			parecer: Parecer;
			model: string;
			promptVersion: string;
	  }
	| { status: "error"; error: string };

// Parecer consolidado do Dossiê (antigo company_reports).
export async function saveDossierReport(
	identity: DbIdentity,
	id: string,
	report: DossierReport,
): Promise<void> {
	await withUserTransaction(identity, async (client) => {
		if (report.status === "error") {
			await client.query(
				"update dossiers set report_status = 'error', generation_error = $2 where id = $1",
				[id, report.error],
			);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "dossier.report",
				targetTable: "dossiers",
				targetId: id,
				outcome: "failure",
			});
			return;
		}
		const p = report.parecer;
		await client.query(
			`update dossiers set
         report_status = 'completed', aptitude_status = $2, executive_summary = $3,
         positive_points = $4::jsonb, risk_points = $5::jsonb, action_plan = $6::jsonb,
         suggested_products = $7::jsonb, suggested_limit = $8, suggested_limit_notes = $9,
         report_markdown = $10, full_report = $11::jsonb, model_used = $12, prompt_version = $13,
         generated_at = now(), generation_error = null
       where id = $1`,
			[
				id,
				toAptitudeStatus(p.apto),
				p.resumo_executivo,
				JSON.stringify(p.pontos_fortes),
				JSON.stringify(p.pontos_atencao),
				JSON.stringify(p.plano_acao),
				JSON.stringify(p.produtos_sugeridos),
				p.limite_sugerido,
				p.limite_sugerido_notas,
				p.relatorio_markdown,
				JSON.stringify(p),
				report.model,
				report.promptVersion,
			],
		);
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "dossier.report",
			targetTable: "dossiers",
			targetId: id,
			metadata: { model: report.model, promptVersion: report.promptVersion },
		});
	});
}

// Entrada da geração do parecer: resultados canônicos das consultas concluídas do Dossiê.
export async function dossierCanonicalResults(
	identity: DbIdentity,
	dossierId: string,
) {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{
			type: EntityKind;
			canonical_result: CanonicalBureauResult;
			payload: unknown;
		}>(
			`select c.type, r.canonical_result, p.payload
         from consultations c join bureau_results r on r.consultation_id = c.id
         left join lateral (
           select bp.payload from bureau_payloads bp
            where bp.consultation_id = c.id
            order by (bp.id is not distinct from r.payload_id) desc, bp.received_at desc limit 1
         ) p on true
        where c.dossier_id = $1 and c.status = 'completed' order by c.created_at`,
			[dossierId],
		);
		return rows;
	});
}

export interface DossierMemberRow {
	id: string;
	type: EntityKind;
	document: string;
	document_name: string | null;
	status: QueryStatus;
	dossier_id: string;
	holder_id: string;
	scr_email: string | null;
	scr_mode: "internal" | "deps";
}

export async function getDossierMember(
	identity: DbIdentity,
	consultationId: string,
): Promise<DossierMemberRow | null> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<DossierMemberRow>(
			`select id, type, document, document_name, status::text, dossier_id, holder_id,
			        scr_email, scr_mode
			   from consultations where id = $1`,
			[consultationId],
		);
		return rows[0] ?? null;
	});
}
