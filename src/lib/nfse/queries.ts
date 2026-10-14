// NFS-e (M3b). A aplicação nunca escreve as colunas nfse_*: só set_nfse_status (role app_webhook) e
// request_nfse_retry (superadmin) as alteram (016_payouts_nfse.sql). A nota nunca toca carteira nem lançamento.
//
// Auditoria: nfse.retry grava o Bureau alvo em bureau_id e a cobrança em record_id (política audit_logs_insert, 017).
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";

export type NfseSettableStatus = "pending" | "issued" | "failed";
export type NfseFailure = "not_allowed" | "not_found" | "invalid_state" | "invalid_status" | "invalid_number" | "invalid_url";

export type NfseFailureRow = {
	chargeId: string;
	bureauId: string;
	amount: string;
	chargeStatus: string;
	attempts: number;
	updatedAt: Date | null;
	createdAt: Date;
};

const FAILURE_LIMIT = 100;

// Notas com falha, para a tela de nova tentativa. Função SQL, não SELECT: o superadmin não lê pix_charges.
// Sem asaas_payment_id nem pix_payload.
export async function listNfseFailures(client: PoolClient): Promise<NfseFailureRow[]> {
	const { rows } = await client.query<{
		charge_id: string;
		bureau_id: string;
		amount: string;
		charge_status: string;
		nfse_attempts: number;
		nfse_updated_at: Date | null;
		created_at: Date;
	}>("select * from list_failed_nfse($1)", [FAILURE_LIMIT]);
	return rows.map((r) => ({
		chargeId: r.charge_id,
		bureauId: r.bureau_id,
		amount: r.amount,
		chargeStatus: r.charge_status,
		attempts: r.nfse_attempts,
		updatedAt: r.nfse_updated_at,
		createdAt: r.created_at,
	}));
}

export type RequestRetryResult = { ok: true } | { ok: false; reason: NfseFailure };

// Nova tentativa manual: failed -> pending e a auditoria, na mesma transação.
export async function requestNfseRetry(identity: DbIdentity, chargeId: string): Promise<RequestRetryResult> {
	return withUserTransaction(identity, async (client) => {
		// Antes da troca: depois dela a cobrança já é pending. Sem linha, request_nfse_retry devolve o motivo.
		const target = await client.query<{ bureau_id: string }>("select bureau_id from nfse_charge_payment($1)", [chargeId]);
		const { rows } = await client.query<{ ok: boolean; reason: NfseFailure | null }>(
			"select ok, reason from request_nfse_retry($1)",
			[chargeId],
		);
		if (!rows[0].ok) return { ok: false, reason: rows[0].reason as NfseFailure };
		if (!target.rows[0]) throw new Error("nfse retry without a Bureau target");
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "nfse.retry",
			targetTable: "pix_charges",
			targetId: chargeId,
			bureauId: target.rows[0].bureau_id,
			metadata: { chargeId },
		});
		return { ok: true };
	});
}

export type SetNfseStatusResult = { ok: true; status: string; changed: boolean } | { ok: false; reason: NfseFailure };

// Role app_webhook (pool do webhook): issued nunca regride e repetir não muda nada.
export async function setNfseStatus(
	chargeId: string,
	status: NfseSettableStatus,
	extra: { number?: string | null; url?: string | null } = {},
): Promise<SetNfseStatusResult> {
	const { rows } = await getWebhookPool().query<{
		ok: boolean;
		reason: NfseFailure | null;
		status: string | null;
		changed: boolean;
	}>("select ok, reason, status, changed from public.set_nfse_status($1, $2, $3, $4)", [
		chargeId,
		status,
		extra.number ?? null,
		extra.url ?? null,
	]);
	const row = rows[0];
	return row.ok
		? { ok: true, status: row.status as string, changed: row.changed }
		: { ok: false, reason: row.reason as NfseFailure };
}

export type NfseCharge = { chargeId: string; amount: string };

// O webhook (app_webhook) não lê tabela alguma: nfse_charge_by_payment (017) liga o id do pagamento do Asaas ao id
// da cobrança paga ou estornada, ou não devolve linha.
export async function findNfseChargeByPayment(asaasPaymentId: string): Promise<NfseCharge | null> {
	const { rows } = await getWebhookPool().query<{ charge_id: string; amount: string }>(
		"select charge_id, amount from public.nfse_charge_by_payment($1)",
		[asaasPaymentId],
	);
	return rows[0] ? { chargeId: rows[0].charge_id, amount: rows[0].amount } : null;
}

export type NfseRetryTarget = { asaasPaymentId: string; amount: string };

// O superadmin não lê pix_charges; nfse_charge_payment (017) devolve o pagamento do Asaas só a ele, sem suporte,
// e só de nota com falha ou em nova tentativa.
export async function findNfseRetryTarget(identity: DbIdentity, chargeId: string): Promise<NfseRetryTarget | null> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ asaas_payment_id: string; amount: string }>(
			"select asaas_payment_id, amount from nfse_charge_payment($1)",
			[chargeId],
		);
		return rows[0] ? { asaasPaymentId: rows[0].asaas_payment_id, amount: rows[0].amount } : null;
	});
}
