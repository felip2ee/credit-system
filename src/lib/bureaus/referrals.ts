// Indicação entre bureaus (bureau_referrals): um indicador por bureau indicado, sem auto-indicação e sem ciclo.
// Só o superadmin fora de suporte escreve (RLS 070). A auditoria vai na mesma transação, como evento da plataforma:
// o bureau indicado fica em target_id e na metadata (o ramo do superadmin em audit_logs_insert exige bureau nulo).
import { writeAuditEvent } from "@/lib/audit/write";
import { assertSplitWithin100, lockCommissionSplit, SplitOver100Error } from "@/lib/commission/queries";
import { platformWriteIdentity, withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { BureauReferrerInput, ClearBureauReferrerInput } from "@/lib/validators/bureau-referral";

const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const PCT_CHECK = "bureau_referrals_pct_check";

export type BureauReferrer = { referrerBureauId: string; referrerName: string; pct: string };
export type SetBureauReferrerResult =
	| { ok: true }
	| { ok: false; reason: "self" | "cycle" | "already_referred" | "not_found" | "split_over_100" };

type PgError = { code?: string; constraint?: string };

export async function getBureauReferrer(identity: DbIdentity, referredBureauId: string): Promise<BureauReferrer | null> {
	const { rows } = await withUserTransaction(identity, (client) =>
		client.query<{ referrer_bureau_id: string; name: string; pct: string }>(
			`select r.referrer_bureau_id, b.name, r.pct
         from bureau_referrals r join bureaus b on b.id = r.referrer_bureau_id
        where r.referred_bureau_id = $1`,
			[referredBureauId],
		),
	);
	const row = rows[0];
	return row ? { referrerBureauId: row.referrer_bureau_id, referrerName: row.name, pct: row.pct } : null;
}

export async function setBureauReferrer(identity: DbIdentity, input: BureauReferrerInput): Promise<SetBureauReferrerResult> {
	const { referredBureauId, referrerBureauId, pct } = input;
	if (referredBureauId === referrerBureauId) return { ok: false, reason: "self" };
	try {
		return await withUserTransaction(platformWriteIdentity(identity), async (client): Promise<SetBureauReferrerResult> => {
			await lockCommissionSplit(client);
			const existing = await client.query("select 1 from bureau_referrals where referred_bureau_id = $1", [referredBureauId]);
			if (existing.rowCount) return { ok: false, reason: "already_referred" };
			await client.query(
				"insert into bureau_referrals (referrer_bureau_id, referred_bureau_id, pct) values ($1, $2, $3)",
				[referrerBureauId, referredBureauId, pct],
			);
			await assertSplitWithin100(client, referredBureauId);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "bureau_referral.set",
				targetTable: "bureaus",
				targetId: referredBureauId,
				metadata: { referred_bureau_id: referredBureauId, referrer_bureau_id: referrerBureauId, pct },
			});
			return { ok: true };
		});
	} catch (error) {
		if (error instanceof SplitOver100Error) return { ok: false, reason: "split_over_100" };
		const { code, constraint } = error as PgError;
		if (code === FOREIGN_KEY_VIOLATION) return { ok: false, reason: "not_found" };
		// O gatilho de ciclo (070) levanta check_violation sem nome de constraint.
		if (code === CHECK_VIOLATION && constraint !== PCT_CHECK) return { ok: false, reason: "cycle" };
		if (code === UNIQUE_VIOLATION) return { ok: false, reason: "already_referred" };
		throw error;
	}
}

// Apaga a linha (076). `removed` falso: não havia indicador (ou o RLS escondeu a linha); nada é auditado.
export async function clearBureauReferrer(
	identity: DbIdentity,
	input: ClearBureauReferrerInput,
): Promise<{ ok: true; removed: boolean }> {
	const { referredBureauId } = input;
	return withUserTransaction(platformWriteIdentity(identity), async (client) => {
		await lockCommissionSplit(client);
		const { rows } = await client.query<{ referrer_bureau_id: string; pct: string }>(
			"delete from bureau_referrals where referred_bureau_id = $1 returning referrer_bureau_id, pct",
			[referredBureauId],
		);
		const removed = rows[0];
		if (!removed) return { ok: true, removed: false };
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "bureau_referral.clear",
			targetTable: "bureaus",
			targetId: referredBureauId,
			metadata: { referred_bureau_id: referredBureauId, referrer_bureau_id: removed.referrer_bureau_id, pct: removed.pct },
		});
		return { ok: true, removed: true };
	});
}
