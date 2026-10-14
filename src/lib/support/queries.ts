// Modo suporte: o superadmin abre uma sessão por Bureau, com motivo, de até 1 hora.
// O RLS (app_support_active) aplica a expiração; aqui só abrimos, encerramos e auditamos.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { platformIdentity, withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export const SUPPORT_REASON_MAX = 500;

export type StartSupportResult =
	| { ok: true; id: string; expiresAt: Date }
	| { ok: false; reason: "bureau_not_found" | "invalid_reason" };

export type EndSupportResult =
	| { ok: true }
	| { ok: false; reason: "no_active_session" };

type EndedSession = { id: string; bureau_id: string; reason: string };

// Início e fim ficam na trilha do Bureau alvo: o contexto de auditoria passa a ser o da sessão de suporte
// só para esta escrita (o RLS de audit_logs exige que a linha repita o contexto).
async function writeSupportAudit(
	client: PoolClient,
	action: "support.start" | "support.end",
	session: { id: string; bureauId: string; reason: string },
	actorId: string,
): Promise<void> {
	await client.query(
		`select set_config('app.bureau_id', $1, true), set_config('app.support_session_id', $2, true)`,
		[session.bureauId, session.id],
	);
	await writeAuditEvent(client, {
		actorId,
		action,
		targetTable: "support_sessions",
		targetId: session.id,
		metadata: { bureauId: session.bureauId, reason: session.reason },
	});
}

async function endOpenSessions(
	client: PoolClient,
	identity: DbIdentity,
): Promise<EndedSession[]> {
	const { rows } = await client.query<EndedSession>(
		`update support_sessions set ended_at = now()
      where superadmin_id = $1 and ended_at is null and expires_at > now()
      returning id, bureau_id, reason`,
		[identity.userId],
	);
	for (const row of rows) {
		await writeSupportAudit(
			client,
			"support.end",
			{ id: row.id, bureauId: row.bureau_id, reason: row.reason },
			identity.userId,
		);
	}
	return rows;
}

export async function startSupportSession(
	identity: DbIdentity,
	input: { bureauId: string; reason: string },
): Promise<StartSupportResult> {
	const reason = input.reason.trim();
	if (reason.length === 0 || reason.length > SUPPORT_REASON_MAX) {
		return { ok: false, reason: "invalid_reason" };
	}
	const platform = platformIdentity(identity);

	return withUserTransaction(platform, async (client) => {
		const bureau = await client.query("select 1 from bureaus where id = $1", [
			input.bureauId,
		]);
		if (bureau.rowCount === 0) return { ok: false, reason: "bureau_not_found" };

		// support.single-open: o gatilho rejeita uma segunda sessão aberta.
		await endOpenSessions(client, platform);
		const { rows } = await client.query<{ id: string; expires_at: Date }>(
			`insert into support_sessions (superadmin_id, bureau_id, reason)
       values ($1, $2, $3) returning id, expires_at`,
			[platform.userId, input.bureauId, reason],
		);
		await writeSupportAudit(
			client,
			"support.start",
			{ id: rows[0].id, bureauId: input.bureauId, reason },
			platform.userId,
		);
		return { ok: true, id: rows[0].id, expiresAt: rows[0].expires_at };
	});
}

export async function endSupportSession(
	identity: DbIdentity,
): Promise<EndSupportResult> {
	const platform = platformIdentity(identity);
	const ended = await withUserTransaction(platform, (client) =>
		endOpenSessions(client, platform),
	);
	return ended.length > 0
		? { ok: true }
		: { ok: false, reason: "no_active_session" };
}
