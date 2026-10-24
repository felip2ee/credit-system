// Retenção LGPD (#50): anonimização a pedido e varreduras. A regra vive nas funções lgpd_* da 023;
// aqui só se chama a função e se grava a auditoria na mesma transação.
import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { recordHolderEvent } from "@/lib/holders/queries";

import type {
	AnonymizeClientFailure,
	AnonymizeClientResult,
	AnonymizeHolderFailure,
	AnonymizeHolderResult,
	AnonymizeInput,
	PurgeCounts,
} from "./types";

const HOLDER_FAILURES: readonly AnonymizeHolderFailure[] = ["not_found", "already_anonymized", "client_active", "open_orders"];
const CLIENT_FAILURES: readonly AnonymizeClientFailure[] = ["not_found", "already_anonymized", "balance", "commission", "open_orders"];

export async function anonymizeHolder(
	identity: DbIdentity,
	input: AnonymizeInput & { holderId: string },
): Promise<AnonymizeHolderResult> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ result: string }>("select lgpd_anonymize_holder($1) as result", [input.holderId]);
		const result = rows[0].result;
		if (result !== "ok") {
			if (!(HOLDER_FAILURES as readonly string[]).includes(result)) throw new Error("unexpected lgpd_anonymize_holder reason");
			return { ok: false, reason: result as AnonymizeHolderFailure };
		}
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "lgpd.anonymize_holder",
			targetTable: "holders",
			targetId: input.holderId,
			metadata: { reason: input.reason },
		});
		await recordHolderEvent(client, identity.userId, input.holderId, {
			eventType: "lgpd.anonymized",
			title: "Titular anonimizado (LGPD)",
		});
		return { ok: true };
	});
}

export async function anonymizeClientAccount(
	identity: DbIdentity,
	input: AnonymizeInput & { profileId: string },
): Promise<AnonymizeClientResult> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ result: string }>("select lgpd_anonymize_client_account($1) as result", [
			input.profileId,
		]);
		const result = rows[0].result;
		if (result !== "ok") {
			if (!(CLIENT_FAILURES as readonly string[]).includes(result)) throw new Error("unexpected lgpd_anonymize_client_account reason");
			return { ok: false, reason: result as AnonymizeClientFailure };
		}
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "lgpd.anonymize_client_account",
			targetTable: "profiles",
			targetId: input.profileId,
			metadata: { reason: input.reason },
		});
		return { ok: true };
	});
}

// Um só processo varre por vez; quem não pega o lock devolve {} (o próximo tick tenta de novo).
// O lock de transação cai sozinho no commit.
export async function purgeTechnicalData(identity: DbIdentity): Promise<PurgeCounts> {
	return withUserTransaction(identity, async (client) => {
		const lock = await client.query<{ locked: boolean }>("select pg_try_advisory_xact_lock(hashtext('lgpd_purge')) as locked");
		if (!lock.rows[0].locked) return {};
		const { rows } = await client.query<{ counts: PurgeCounts }>("select lgpd_purge_technical() as counts");
		return rows[0].counts;
	});
}

// A auditoria sai sempre, mesmo com contagens zeradas: é ela que marca a última varredura (lgpd_sweep_targets, 24 h).
export async function purgeBureauData(identity: DbIdentity): Promise<PurgeCounts> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ counts: PurgeCounts }>("select lgpd_purge_bureau() as counts");
		const counts = rows[0].counts;
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "lgpd.purge_bureau",
			metadata: counts,
		});
		return counts;
	});
}

export type SweepTarget = { bureauId: string; systemProfileId: string };

// Bureaus ativos sem varredura nas últimas 24 h, com o perfil de sistema que assume a varredura.
export async function listSweepTargets(identity: DbIdentity): Promise<SweepTarget[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ bureau_id: string; system_profile_id: string }>(
			"select bureau_id, system_profile_id from lgpd_sweep_targets() order by bureau_id",
		);
		return rows.map((row) => ({ bureauId: row.bureau_id, systemProfileId: row.system_profile_id }));
	});
}
