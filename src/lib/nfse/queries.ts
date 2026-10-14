// NFS-e (M3b). A aplicação nunca escreve as colunas nfse_*: só set_nfse_status (role app_webhook) e
// request_nfse_retry (superadmin) as alteram (016_payouts_nfse.sql). A nota nunca toca carteira nem lançamento.
//
// Auditoria: a política audit_logs_insert (012) não aceita bureau_id alvo para nfse.retry; o evento vai com
// bureau_id nulo (plataforma) e a cobrança em record_id.
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
		const { rows } = await client.query<{ ok: boolean; reason: NfseFailure | null }>(
			"select ok, reason from request_nfse_retry($1)",
			[chargeId],
		);
		if (!rows[0].ok) return { ok: false, reason: rows[0].reason as NfseFailure };
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "nfse.retry",
			targetTable: "pix_charges",
			targetId: chargeId,
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

// PENDENTE DE MIGRATION: o webhook (app_webhook) não lê tabela alguma, e nenhuma função da 016 liga o id do
// pagamento do Asaas ao id da cobrança. Contrato esperado (ver task-6-report.md): SECURITY DEFINER,
// EXECUTE só para app_webhook, devolve a cobrança paga/estornada do pagamento, ou nenhuma linha.
export async function findNfseChargeByPayment(asaasPaymentId: string): Promise<NfseCharge | null> {
	const { rows } = await getWebhookPool().query<{ charge_id: string; amount: string }>(
		"select charge_id, amount from public.nfse_charge_by_payment($1)",
		[asaasPaymentId],
	);
	return rows[0] ? { chargeId: rows[0].charge_id, amount: rows[0].amount } : null;
}

export type NfseRetryTarget = { asaasPaymentId: string; amount: string };

// PENDENTE DE MIGRATION: superadmin não lê pix_charges; a nova tentativa precisa do pagamento do Asaas.
// Contrato esperado: SECURITY DEFINER, só superadmin sem suporte, só para cobrança em nfse_status = 'pending'.
export async function findNfseRetryTarget(identity: DbIdentity, chargeId: string): Promise<NfseRetryTarget | null> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ asaas_payment_id: string; amount: string }>(
			"select asaas_payment_id, amount from nfse_charge_payment($1)",
			[chargeId],
		);
		return rows[0] ? { asaasPaymentId: rows[0].asaas_payment_id, amount: rows[0].amount } : null;
	});
}
