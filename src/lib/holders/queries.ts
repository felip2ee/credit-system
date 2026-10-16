// Titular e Sociedade — SQL parametrizado sob o contexto de tenant da transação.
// O bureau_id de escrita vem sempre de app_bureau_id() (a identidade), nunca de parâmetro.
// Conflitos de negócio voltam como `{ ok: false, reason }`; qualquer outro erro lança.

import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { onlyDigits } from "@/lib/utils";
import type {
	EntityKind,
	HolderNote,
	PartnershipSource,
	TimelineEvent,
} from "@/types/app";

export type HolderInput = {
	type: EntityKind;
	name: string;
	document: string;
	email?: string | null;
	phone?: string | null;
	address?: string | null;
	addressNumber?: string | null;
	addressComplement?: string | null;
	neighborhood?: string | null;
	city?: string | null;
	state?: string | null;
	zipCode?: string | null;
	notes?: string | null;
};

const UNIQUE_VIOLATION = "23505";
const HOLDER_DOCUMENT_UNIQUE = "holders_document_unique";

function isDuplicateDocument(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === UNIQUE_VIOLATION &&
		"constraint" in error &&
		error.constraint === HOLDER_DOCUMENT_UNIQUE
	);
}

type TimelineEventInput = {
	eventType: string;
	title: string;
	description?: string | null;
	metadata?: Record<string, unknown> | null;
};

// Evento na linha do tempo do Titular, no cliente da transação do chamador.
export async function recordHolderEvent(
	client: PoolClient,
	actorId: string,
	holderId: string,
	event: TimelineEventInput,
): Promise<void> {
	await client.query(
		`insert into timeline_events
       (bureau_id, entity_type, entity_id, event_type, title, description, metadata, created_by)
     values (app_bureau_id(), 'holder', $1, $2, $3, $4, $5::jsonb, $6)`,
		[
			holderId,
			event.eventType,
			event.title,
			event.description ?? null,
			event.metadata ? JSON.stringify(event.metadata) : null,
			actorId,
		],
	);
}

export async function createHolder(
	identity: DbIdentity,
	input: HolderInput,
): Promise<
	{ ok: true; id: string } | { ok: false; reason: "duplicate_document" }
> {
	return withUserTransaction(identity, async (client) => {
		const inserted = await client.query<{ id: string }>(
			`insert into holders
         (bureau_id, type, name, document, email, phone, address, address_number,
          address_complement, neighborhood, city, state, zip_code, notes, created_by)
       values (app_bureau_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict on constraint ${HOLDER_DOCUMENT_UNIQUE} do nothing
       returning id`,
			[
				input.type,
				input.name,
				input.document,
				input.email ?? null,
				input.phone ?? null,
				input.address ?? null,
				input.addressNumber ?? null,
				input.addressComplement ?? null,
				input.neighborhood ?? null,
				input.city ?? null,
				input.state ?? null,
				input.zipCode ?? null,
				input.notes ?? null,
				identity.userId,
			],
		);
		const id = inserted.rows[0]?.id;
		if (!id) return { ok: false, reason: "duplicate_document" } as const;

		await recordHolderEvent(client, identity.userId, id, {
			eventType: "holder.created",
			title: "Titular cadastrado",
			description: input.name,
		});
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "holder.create",
			targetTable: "holders",
			targetId: id,
			metadata: { type: input.type, name: input.name },
		});
		return { ok: true, id } as const;
	});
}

export async function updateHolder(
	identity: DbIdentity,
	id: string,
	input: HolderInput,
): Promise<
	{ ok: true } | { ok: false; reason: "not_found" | "duplicate_document" }
> {
	return withUserTransaction(identity, async (client) => {
		try {
			const updated = await client.query(
				`update holders set
           name = $2, document = $3, email = $4, phone = $5, address = $6,
           address_number = $7, address_complement = $8, neighborhood = $9,
           city = $10, state = $11, zip_code = $12, notes = $13
         where id = $1`,
				[
					id,
					input.name,
					input.document,
					input.email ?? null,
					input.phone ?? null,
					input.address ?? null,
					input.addressNumber ?? null,
					input.addressComplement ?? null,
					input.neighborhood ?? null,
					input.city ?? null,
					input.state ?? null,
					input.zipCode ?? null,
					input.notes ?? null,
				],
			);
			if (updated.rowCount === 0)
				return { ok: false, reason: "not_found" } as const;
		} catch (error) {
			// A transação aborta; o commit seguinte vira rollback e nada foi gravado antes.
			if (isDuplicateDocument(error))
				return { ok: false, reason: "duplicate_document" } as const;
			throw error;
		}
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "holder.update",
			targetTable: "holders",
			targetId: id,
			metadata: { name: input.name },
		});
		return { ok: true } as const;
	});
}

// Reusa o Titular do Bureau com o mesmo documento (só dígitos); senão cria.
export async function ensureHolder(
	client: PoolClient,
	actorId: string,
	input: Pick<HolderInput, "type" | "name" | "document">,
): Promise<string> {
	const document = onlyDigits(input.document);
	const inserted = await client.query<{ id: string }>(
		`insert into holders (bureau_id, type, name, document, created_by)
     values (app_bureau_id(), $1, $2, $3, $4)
     on conflict on constraint ${HOLDER_DOCUMENT_UNIQUE} do nothing
     returning id`,
		[input.type, input.name, document, actorId],
	);
	if (inserted.rows[0]) {
		await recordHolderEvent(client, actorId, inserted.rows[0].id, {
			eventType: "holder.created",
			title: "Titular cadastrado",
			description: input.name,
		});
		await writeAuditEvent(client, {
			actorId,
			action: "holder.create",
			targetTable: "holders",
			targetId: inserted.rows[0].id,
			metadata: { type: input.type, name: input.name, document },
		});
		return inserted.rows[0].id;
	}
	const { rows } = await client.query<{ id: string }>(
		"select id from holders where document_digits = $1",
		[document],
	);
	return rows[0].id;
}

// Sociedade: a empresa (PJ) e o sócio. Uma linha por par; a segunda chamada atualiza.
// Dado da DEPS nunca sobrescreve o que o operador informou.
export async function upsertPartnership(
	client: PoolClient,
	actorId: string,
	input: {
		companyId: string;
		partnerId: string;
		percentage: number | null;
		role: string | null;
		source: PartnershipSource;
	},
): Promise<
	{ ok: true } | { ok: false; reason: "company_not_pj" | "self_link" }
> {
	if (input.companyId === input.partnerId)
		return { ok: false, reason: "self_link" };

	const company = await client.query<{ type: EntityKind }>(
		"select type from holders where id = $1",
		[input.companyId],
	);
	if (company.rows[0]?.type !== "PJ")
		return { ok: false, reason: "company_not_pj" };

	await client.query(
		`insert into holder_partnerships
       (bureau_id, company_id, partner_id, percentage, role, source, created_by)
     values (app_bureau_id(), $1, $2, $3, $4, $5, $6)
     on conflict (company_id, partner_id) do update set
       percentage = coalesce(excluded.percentage, holder_partnerships.percentage),
       role = coalesce(excluded.role, holder_partnerships.role),
       source = excluded.source
     where not (holder_partnerships.source = 'operator' and excluded.source = 'deps')`,
		[
			input.companyId,
			input.partnerId,
			input.percentage,
			input.role,
			input.source,
			actorId,
		],
	);
	return { ok: true };
}

// Sócio informado pelo operador: cria ou reusa o Titular do sócio e grava a Sociedade.
export async function linkPartner(
	identity: DbIdentity,
	companyId: string,
	partner: {
		document: string;
		name: string;
		percentage: number | null;
		role: string | null;
	},
): Promise<
	| { ok: true; id: string }
	| { ok: false; reason: "company_not_pj" | "self_link" }
> {
	return withUserTransaction(identity, async (client) => {
		// Valida a empresa antes de criar o Titular do sócio: o retorno normal faria commit do órfão.
		const company = await client.query<{ type: EntityKind }>(
			"select type from holders where id = $1",
			[companyId],
		);
		if (company.rows[0]?.type !== "PJ")
			return { ok: false, reason: "company_not_pj" } as const;

		const partnerId = await ensureHolder(client, identity.userId, {
			type: onlyDigits(partner.document).length === 14 ? "PJ" : "PF",
			name: partner.name,
			document: partner.document,
		});
		const linked = await upsertPartnership(client, identity.userId, {
			companyId,
			partnerId,
			percentage: partner.percentage,
			role: partner.role,
			source: "operator",
		});
		if (!linked.ok) return linked;
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "holder.partner_link",
			targetTable: "holder_partnerships",
			targetId: companyId,
			metadata: { partnerId, name: partner.name },
		});
		return { ok: true, id: partnerId } as const;
	});
}

export async function addHolderNote(
	identity: DbIdentity,
	holderId: string,
	content: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
	return withUserTransaction(identity, async (client) => {
		const found = await client.query("select 1 from holders where id = $1", [
			holderId,
		]);
		if (found.rowCount === 0)
			return { ok: false, reason: "not_found" } as const;

		await client.query(
			`insert into crm_notes (bureau_id, entity_type, entity_id, content, created_by)
       values (app_bureau_id(), 'holder', $1, $2, $3)`,
			[holderId, content, identity.userId],
		);
		await recordHolderEvent(client, identity.userId, holderId, {
			eventType: "note.added",
			title: "Anotação adicionada",
			description: content.slice(0, 140),
		});
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "holder.note_add",
			targetTable: "crm_notes",
			targetId: holderId,
		});
		return { ok: true } as const;
	});
}

// ── Leituras ─────────────────────────────────────────────────────────────

export interface HolderListItem {
	id: string;
	type: EntityKind;
	name: string;
	document: string;
	email: string | null;
	city: string | null;
	state: string | null;
	updated_at: string;
	client_profile_id: string | null;
}

const LIST_LIMIT = 100;

export async function listHolders(
	identity: DbIdentity,
	filters: { type?: EntityKind; q?: string; portalOnly?: boolean },
): Promise<HolderListItem[]> {
	const term = filters.q?.trim() ?? "";
	const digits = term.replace(/\D/g, "");
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<HolderListItem>(
			`select id, type, name, document, email, city, state, updated_at::text, client_profile_id
         from holders
        where ($1::query_type is null or type = $1::query_type)
          and ($4 = false or client_profile_id is not null)
          and ($2 = '' or name ilike '%' || $2 || '%'
               or ($3 <> '' and document_digits like '%' || $3 || '%'))
        order by updated_at desc
        limit ${LIST_LIMIT}`,
			[filters.type ?? null, term, digits, filters.portalOnly === true],
		);
		return rows;
	});
}

export interface HolderRow {
	id: string;
	type: EntityKind;
	name: string;
	document: string;
	email: string | null;
	phone: string | null;
	address: string | null;
	address_number: string | null;
	address_complement: string | null;
	neighborhood: string | null;
	city: string | null;
	state: string | null;
	zip_code: string | null;
	notes: string | null;
	client_profile_id: string | null;
	anonymized_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface PartnershipRow {
	holder_id: string;
	name: string;
	document: string;
	type: EntityKind;
	percentage: number | null;
	role: string | null;
	source: PartnershipSource;
}

export interface HolderConsultationRow {
	id: string;
	dossier_id: string;
	type: EntityKind;
	document: string;
	document_name: string | null;
	product: string | null;
	status: string;
	consulted_at: string | null;
	created_at: string;
}

export interface HolderDossierRow {
	id: string;
	kind: string;
	status: string;
	report_status: string;
	aptitude_status: string;
	created_at: string;
}

export interface HolderDetail {
	holder: HolderRow;
	companies: PartnershipRow[]; // empresas em que o Titular é sócio
	partners: PartnershipRow[]; // sócios da empresa
	consultations: HolderConsultationRow[];
	dossiers: HolderDossierRow[];
	timeline: TimelineEvent[];
	notes: HolderNote[];
}

export async function getHolderDetail(
	identity: DbIdentity,
	id: string,
): Promise<HolderDetail | null> {
	return withUserTransaction(identity, async (client) => {
		const holder = await client.query<HolderRow>(
			`select id, type, name, document, email, phone, address, address_number,
              address_complement, neighborhood, city, state, zip_code, notes,
              client_profile_id, anonymized_at::text, created_at::text, updated_at::text
         from holders where id = $1`,
			[id],
		);
		if (holder.rowCount === 0) return null;

		const companies = await client.query<PartnershipRow>(
			`select h.id as holder_id, h.name, h.document, h.type, p.percentage::float8 as percentage,
                p.role, p.source
           from holder_partnerships p join holders h on h.id = p.company_id
          where p.partner_id = $1 order by h.name`,
			[id],
		);
		const partners = await client.query<PartnershipRow>(
			`select h.id as holder_id, h.name, h.document, h.type, p.percentage::float8 as percentage,
                p.role, p.source
           from holder_partnerships p join holders h on h.id = p.partner_id
          where p.company_id = $1 order by h.name`,
			[id],
		);
		const consultations = await client.query<HolderConsultationRow>(
			`select id, dossier_id, type, document, document_name, product, status::text,
                consulted_at::text, created_at::text
           from consultations where holder_id = $1 order by created_at desc limit 50`,
			[id],
		);
		const dossiers = await client.query<HolderDossierRow>(
			`select id, kind::text, status::text, report_status, aptitude_status, created_at::text
           from dossiers where holder_id = $1 order by created_at desc`,
			[id],
		);
		const timeline = await client.query<TimelineEvent>(
			`select id, entity_type::text, entity_id, event_type, title, description, metadata,
                created_by, created_at::text
           from timeline_events
          where entity_type = 'holder' and entity_id = $1 order by created_at desc`,
			[id],
		);
		const notes = await client.query<HolderNote>(
			`select id, content, created_by, created_at::text
           from crm_notes
          where entity_type = 'holder' and entity_id = $1 order by created_at desc`,
			[id],
		);

		return {
			holder: holder.rows[0],
			companies: companies.rows,
			partners: partners.rows,
			consultations: consultations.rows,
			dossiers: dossiers.rows,
			timeline: timeline.rows,
			notes: notes.rows,
		};
	});
}
