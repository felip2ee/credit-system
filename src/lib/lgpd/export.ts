// Exportação dos dados de um Titular (LGPD art. 18). Lê sob RLS da equipe; a auditoria vai na mesma transação.
// Fora da exportação: auth_code, public_token e consent_ip das autorizações SCR, e os dados de outros Titulares.
import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

import type { HolderExport } from "./types";

export async function exportHolder(identity: DbIdentity, holderId: string): Promise<HolderExport | null> {
	return withUserTransaction(identity, async (client) => {
		const holder = await client.query(
			`select id, type, name, document, email, phone, address, address_number, address_complement,
              neighborhood, city, state, zip_code, notes, anonymized_at, created_at, updated_at
         from holders where id = $1`,
			[holderId],
		);
		if (holder.rowCount === 0) return null;

		// Só o vínculo: nome e documento da outra parte são dados de outro Titular.
		const partnerships = await client.query(
			`select company_id, partner_id, percentage::float8 as percentage, role, source, created_at
         from holder_partnerships where company_id = $1 or partner_id = $1 order by created_at`,
			[holderId],
		);
		const dossiers = await client.query(
			`select id, kind::text as kind, product, status::text as status, started_at, completed_at, report_status,
              aptitude_status, executive_summary, positive_points, risk_points, action_plan, suggested_products,
              suggested_limit, suggested_limit_notes, report_markdown, full_report, created_at
         from dossiers where holder_id = $1 order by created_at`,
			[holderId],
		);
		const consultations = await client.query(
			`select c.id, c.dossier_id, c.type::text as type, c.document, c.document_name, c.product,
              c.status::text as status, c.observations, c.consulted_at, c.created_at,
              case when r.consultation_id is null then null else jsonb_build_object(
                'document', r.document, 'personName', r.person_name, 'score', r.score, 'riskLevel', r.risk_level,
                'canonicalResult', r.canonical_result, 'createdAt', r.created_at) end as result,
              case when a.id is null then null else jsonb_build_object(
                'status', a.status, 'aptitudeStatus', a.aptitude_status, 'executiveSummary', a.executive_summary,
                'positivePoints', a.positive_points, 'riskPoints', a.risk_points, 'actionPlan', a.action_plan,
                'suggestedProducts', a.suggested_products, 'suggestedLimitNotes', a.suggested_limit_notes,
                'reportMarkdown', a.report_markdown, 'fullReport', a.full_report, 'consultantNotes', a.consultant_notes,
                'generatedAt', a.generated_at) end as "aiReport"
         from consultations c
         left join bureau_results r on r.consultation_id = c.id
         left join ai_reports a on a.consultation_id = c.id
        where c.holder_id = $1 order by c.created_at`,
			[holderId],
		);
		const scrAuthorizations = await client.query(
			`select id, consultation_id, document, type::text as type, name, email, status::text as status, channel,
              requested_at, authorized_at, expires_at, consent_text, consent_name, consent_document, consented_at,
              refused_at, created_at
         from scr_authorizations where holder_id = $1 order by created_at`,
			[holderId],
		);
		const orders = await client.query(
			`select o.dossier_id, o.mode, o.product_code, o.state, o.state_reason, o.created_at, o.released_at,
              s.price::text as price
         from dossier_orders o
         join dossiers d on d.id = o.dossier_id and d.bureau_id = o.bureau_id
         left join order_settlements s on s.order_ref = o.dossier_id
        where d.holder_id = $1 order by o.created_at`,
			[holderId],
		);
		const timeline = await client.query(
			`select id, event_type, title, description, metadata, created_at
         from timeline_events where entity_type = 'holder' and entity_id = $1 order by created_at`,
			[holderId],
		);
		const notes = await client.query(
			`select id, content, created_at
         from crm_notes where entity_type = 'holder' and entity_id = $1 order by created_at`,
			[holderId],
		);

		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "lgpd.export_holder",
			targetTable: "holders",
			targetId: holderId,
		});

		return {
			holder: holder.rows[0],
			partnerships: partnerships.rows,
			dossiers: dossiers.rows,
			consultations: consultations.rows,
			scrAuthorizations: scrAuthorizations.rows,
			orders: orders.rows,
			timeline: timeline.rows,
			notes: notes.rows,
			exportedAt: new Date().toISOString(),
		};
	});
}
