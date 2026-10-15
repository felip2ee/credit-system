// Pagamento recebido no balcão (M3b). Não mexe em nenhuma carteira. Insere direto (RLS exige a equipe do Bureau);
// a anulação passa por void_counter_payment (015_client_wallet_settlement.sql). Auditoria na mesma transação.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export type CounterMethod = "cash" | "pix" | "card_machine" | "transfer" | "other";

export type RegisterInput = {
	dossierId: string;
	method: CounterMethod;
	amount: string;
	note: string | null;
	receivedAt: Date;
};

export type VoidInput = { id: string; reason: string };

export type CounterFailure =
	| "not_found"
	| "not_allowed"
	| "reason_required"
	| "already_voided"
	| "invalid_state"
	| "online_settlement";

export type RegisterResult = { ok: true; id: string } | { ok: false; reason: "not_found" | "online_settlement" };
export type VoidResult = { ok: true } | { ok: false; reason: CounterFailure };

export type CounterPayment = {
	id: string;
	dossierId: string;
	method: CounterMethod;
	amount: string;
	receivedAt: Date;
	registeredBy: string;
	note: string | null;
	voidedAt: Date | null;
	voidedBy: string | null;
	voidReason: string | null;
};

export type CounterPaymentsView = {
	payments: CounterPayment[];
	// Soma dos pagamentos não anulados, em reais com 2 casas.
	paidTotal: string;
	// Preço da liquidação do pedido (order_ref = Dossiê), se existir.
	price: string | null;
};

const FOREIGN_KEY_VIOLATION = "23503";

export async function registerCounterPayment(identity: DbIdentity, input: RegisterInput): Promise<RegisterResult> {
	try {
		const id = await withUserTransaction(identity, async (client) => {
			// Dossiê liquidado online é pago pela carteira do cliente: pagamento de balcão em cima dele duplicaria a cobrança.
			const settlement = await client.query<{ mode: string }>("select mode from order_settlements where order_ref = $1", [
				input.dossierId,
			]);
			if (settlement.rows[0]?.mode === "online") return null;
			const { rows } = await client.query<{ id: string }>(
				`insert into counter_payments (bureau_id, dossier_id, method, amount, received_at, registered_by, note)
				 values (app_bureau_id(), $1, $2, $3, $4, app_user_id(), $5)
				 returning id`,
				[input.dossierId, input.method, input.amount, input.receivedAt, input.note],
			);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "counter.register",
				targetTable: "counter_payments",
				targetId: rows[0].id,
				metadata: { dossier_id: input.dossierId, method: input.method, amount: input.amount },
			});
			return rows[0].id;
		});
		return id === null ? { ok: false, reason: "online_settlement" } : { ok: true, id };
	} catch (error) {
		// A FK (bureau_id, dossier_id) recusa Dossiê inexistente ou de outro Bureau; a transação já voltou.
		if (error instanceof Error && "code" in error && error.code === FOREIGN_KEY_VIOLATION) {
			return { ok: false, reason: "not_found" };
		}
		throw error;
	}
}

export async function voidCounterPayment(identity: DbIdentity, input: VoidInput): Promise<VoidResult> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ ok: boolean; reason: CounterFailure | null }>(
			"select ok, reason from void_counter_payment($1, $2)",
			[input.id, input.reason],
		);
		if (!rows[0].ok) return { ok: false, reason: rows[0].reason ?? "invalid_state" };
		// O motivo fica na linha; a auditoria leva só o contexto do valor.
		const payment = await client.query<{ dossier_id: string; amount: string }>(
			"select dossier_id, amount from counter_payments where id = $1",
			[input.id],
		);
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "counter.void",
			targetTable: "counter_payments",
			targetId: input.id,
			metadata: { dossier_id: payment.rows[0].dossier_id, amount: payment.rows[0].amount },
		});
		return { ok: true };
	});
}

type PaymentRow = {
	id: string;
	dossier_id: string;
	method: CounterMethod;
	amount: string;
	received_at: Date;
	registered_by: string;
	note: string | null;
	voided_at: Date | null;
	voided_by: string | null;
	void_reason: string | null;
};

export async function listCounterPayments(client: PoolClient, dossierId: string): Promise<CounterPaymentsView> {
	const payments = await client.query<PaymentRow>(
		`select id, dossier_id, method, amount, received_at, registered_by, note, voided_at, voided_by, void_reason
		   from counter_payments
		  where dossier_id = $1
		  order by received_at desc, created_at desc, id`,
		[dossierId],
	);
	const settlement = await client.query<{ price: string }>(
		"select price from order_settlements where order_ref = $1",
		[dossierId],
	);
	const list = payments.rows.map((r) => ({
		id: r.id,
		dossierId: r.dossier_id,
		method: r.method,
		amount: r.amount,
		receivedAt: r.received_at,
		registeredBy: r.registered_by,
		note: r.note,
		voidedAt: r.voided_at,
		voidedBy: r.voided_by,
		voidReason: r.void_reason,
	}));
	// Soma no banco (numeric): somar em centavos no JS estoura o limite de toCents com poucos pagamentos grandes.
	const total = await client.query<{ paid_total: string }>(
		"select coalesce(sum(amount), 0.00)::text as paid_total from counter_payments where dossier_id = $1 and voided_at is null",
		[dossierId],
	);
	return { payments: list, paidTotal: total.rows[0].paid_total, price: settlement.rows[0]?.price ?? null };
}
