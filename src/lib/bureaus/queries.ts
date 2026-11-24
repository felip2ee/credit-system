// Painel do superadmin: Bureaus, convite do primeiro admin e métricas.
// A permissão `bureaus:manage` é checada na action; aqui o RLS barra quem não é superadmin.
import { writeAuditEvent } from "@/lib/audit/write";
import {
	setTemporaryCredentials,
	type CredentialsOutcome,
} from "@/lib/auth/credentials";
import { createInvite, type InviteOutcome } from "@/lib/auth/invite";
import { platformIdentity, withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { BureauCreate, BureauUpdate } from "@/lib/validators/bureau";

export type BureauStatus = "active" | "inactive";

export type BureauSummary = {
	id: string;
	name: string;
	slug: string;
	status: BureauStatus;
};

export type BureauMetrics = {
	bureauId: string;
	name: string;
	slug: string;
	status: BureauStatus;
	staffCount: number;
	holderCount: number;
	dossierCount: number;
	consultationCount: number;
	consultations30d: number;
};

export type CreateBureauResult =
	| { ok: true; id: string; adminEmail: string }
	| { ok: false; reason: "slug_taken" | "slug_reserved" | "email_in_use" };

// Aborta a transação do createBureau sem lançar erro de banco.
class EmailInUse extends Error {}

type PgError = { code?: string; constraint?: string };

export async function createBureau(
	identity: DbIdentity,
	input: BureauCreate,
): Promise<CreateBureauResult> {
	try {
		return await withUserTransaction(platformIdentity(identity), async (client) => {
			// Um slug que já foi de outro bureau segue reservado para o redirect 308.
			const reserved = await client.query("select 1 from bureau_slug_history where old_slug = $1", [input.slug]);
			if (reserved.rowCount) return { ok: false as const, reason: "slug_taken" as const };
			const { rows } = await client.query<{ id: string }>(
				"insert into bureaus (name, slug) values ($1, $2) returning id",
				[input.name.trim(), input.slug],
			);
			const id = rows[0].id;
			const invite = await createInvite(client, identity.userId, {
				email: input.adminEmail,
				fullName: input.adminName,
				role: "bureau_admin",
				bureauId: id,
				password: input.adminPassword,
			});
			if (!invite.ok) throw new EmailInUse();
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "bureau.create",
				targetTable: "bureaus",
				targetId: id,
				metadata: { slug: input.slug },
			});
			return {
				ok: true as const,
				id,
				adminEmail: input.adminEmail.trim().toLowerCase(),
			};
		});
	} catch (error) {
		if (error instanceof EmailInUse)
			return { ok: false, reason: "email_in_use" };
		const pg = error as PgError;
		if (pg.code === "23505" && pg.constraint === "bureaus_slug_key") {
			return { ok: false, reason: "slug_taken" };
		}
		if (pg.code === "23514" && pg.constraint === "bureaus_slug_not_reserved") {
			return { ok: false, reason: "slug_reserved" };
		}
		throw error;
	}
}

export type UpdateBureauResult =
	| { ok: true }
	| { ok: false; reason: "not_found" | "slug_taken" | "slug_reserved" };

// Troca de slug: o antigo vai para bureau_slug_history (redirect 308) na mesma transação.
// Rejeita um slug que é old_slug de OUTRO bureau; voltar ao próprio old_slug apaga essa linha.
export async function updateBureau(
	identity: DbIdentity,
	input: BureauUpdate,
): Promise<UpdateBureauResult> {
	try {
		return await withUserTransaction(platformIdentity(identity), async (client) => {
			const { rows } = await client.query<{ slug: string }>(
				"select slug from bureaus where id = $1 for update",
				[input.id],
			);
			if (!rows[0]) return { ok: false as const, reason: "not_found" as const };
			const oldSlug = rows[0].slug;
			const newSlug = input.slug && input.slug !== oldSlug ? input.slug : null;

			if (newSlug) {
				const { rows: owners } = await client.query<{ bureau_id: string }>(
					"select bureau_id from bureau_slug_history where old_slug = $1",
					[newSlug],
				);
				if (owners[0] && owners[0].bureau_id !== input.id) {
					return { ok: false as const, reason: "slug_taken" as const };
				}
				// Apaga o novo slug (voltou ao próprio antigo) e o atual (evita PK duplicada se ele já era antigo de outro).
				await client.query("delete from bureau_slug_history where old_slug = any($1)", [[newSlug, oldSlug]]);
				await client.query("insert into bureau_slug_history (old_slug, bureau_id) values ($1, $2)", [oldSlug, input.id]);
			}

			await client.query("update bureaus set name = $2, slug = coalesce($3, slug) where id = $1", [
				input.id,
				input.name.trim(),
				newSlug,
			]);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "bureau.update",
				targetTable: "bureaus",
				targetId: input.id,
				metadata: newSlug ? { slugFrom: oldSlug, slugTo: newSlug } : undefined,
			});
			return { ok: true as const };
		});
	} catch (error) {
		const pg = error as PgError;
		if (pg.code === "23505" && pg.constraint === "bureaus_slug_key") {
			return { ok: false, reason: "slug_taken" };
		}
		if (pg.code === "23514" && pg.constraint === "bureaus_slug_not_reserved") {
			return { ok: false, reason: "slug_reserved" };
		}
		throw error;
	}
}

export async function setBureauStatus(
	identity: DbIdentity,
	id: string,
	status: BureauStatus,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		const { rowCount } = await client.query(
			"update bureaus set status = $2 where id = $1",
			[id, status],
		);
		if (!rowCount) return { ok: false as const, reason: "not_found" as const };
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: status === "active" ? "bureau.activate" : "bureau.deactivate",
			targetTable: "bureaus",
			targetId: id,
		});
		return { ok: true as const };
	});
}

export async function getBureau(
	identity: DbIdentity,
	id: string,
): Promise<BureauSummary | null> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<BureauSummary>(
			"select id, name, slug, status from bureaus where id = $1",
			[id],
		);
		return rows[0] ?? null;
	});
}

// Nome do Bureau da sessão (RLS limita ao próprio Bureau); nulo se a sessão não tem Bureau.
export async function getOwnBureauName(identity: DbIdentity): Promise<string | null> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ name: string }>("select name from bureaus where id = app_bureau_id()");
		return rows[0]?.name ?? null;
	});
}

// Só id e nome (RLS: o superadmin vê todos); para rotular listas sem pagar o custo das métricas.
export async function listBureauNames(identity: DbIdentity): Promise<Map<string, string>> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ id: string; name: string }>("select id, name from bureaus");
		return new Map(rows.map((r) => [r.id, r.name]));
	});
}

type MetricsRow = {
	bureau_id: string;
	name: string;
	slug: string;
	status: BureauStatus;
	staff_count: string;
	holder_count: string;
	dossier_count: string;
	consultation_count: string;
	consultations_30d: string;
};

// Só contagens por Bureau (platform_bureau_metrics): nenhum dado pessoal sai do banco.
export async function listBureauMetrics(
	identity: DbIdentity,
): Promise<BureauMetrics[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<MetricsRow>(
			"select * from platform_bureau_metrics()",
		);
		return rows.map((r) => ({
			bureauId: r.bureau_id,
			name: r.name,
			slug: r.slug,
			status: r.status,
			staffCount: Number(r.staff_count),
			holderCount: Number(r.holder_count),
			dossierCount: Number(r.dossier_count),
			consultationCount: Number(r.consultation_count),
			consultations30d: Number(r.consultations_30d),
		}));
	});
}

export async function inviteBureauAdmin(
	identity: DbIdentity,
	input: { bureauId: string; name: string; email: string; password?: string },
): Promise<InviteOutcome> {
	return withUserTransaction(platformIdentity(identity), (client) =>
		createInvite(client, identity.userId, {
			email: input.email,
			fullName: input.name,
			role: "bureau_admin",
			bureauId: input.bureauId,
			password: input.password,
		}),
	);
}

// Define a senha temporária (ou só força a troca, com password null) do admin de um Bureau.
// O gateway SQL confere que o e-mail é de um bureau_admin deste Bureau.
export async function setBureauAdminCredentials(
	identity: DbIdentity,
	input: { bureauId: string; email: string; password: string | null },
): Promise<CredentialsOutcome> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		const { rows } = await client.query<{ id: string }>(
			'select id from "user" where lower(email) = $1',
			[input.email.trim().toLowerCase()],
		);
		if (!rows[0]) return { ok: false as const, reason: "not_found" as const };
		return setTemporaryCredentials(client, identity.userId, {
			targetId: rows[0].id,
			bureauId: input.bureauId,
			password: input.password,
		});
	});
}
