// Liquidação por pedido (M3b). Nenhuma regra de saldo vive aqui: reserve_order, capture_order e release_order
// (015_client_wallet_settlement.sql) decidem, e estas funções só traduzem o resultado e gravam a auditoria.
// Todas recebem o PoolClient da transação do chamador; a identidade vem do contexto dela.
import type { PoolClient } from "pg";

import { fromCents } from "@/lib/catalog/money";
import { writeAuditEvent } from "@/lib/audit/write";

import type {
	ReserveOrderInput,
	Settlement,
	SettlementCost,
	SettlementFailure,
	SettlementResult,
	SettlementStatus,
} from "./types";

type ResultRow = { ok: boolean; reason: SettlementFailure | null; status: SettlementStatus | null };

function toResult(row: ResultRow): SettlementResult {
	return row.ok
		? { ok: true, status: row.status as SettlementStatus }
		: { ok: false, reason: row.reason as SettlementFailure };
}

// created_at/closed_at = now() só na transação que fez a transição: uma repetição não audita de novo.
async function auditTransition(
	client: PoolClient,
	orderRef: string,
	action: "settlement.reserve" | "settlement.capture" | "settlement.release",
): Promise<void> {
	const stamp = action === "settlement.reserve" ? "created_at" : "closed_at";
	const { rows } = await client.query<{
		id: string;
		actor: string;
		mode: string;
		status: string;
		price: string;
		fresh: boolean;
	}>(
		`select id, app_user_id()::text as actor, mode, status, price, (${stamp} = now()) as fresh
		   from order_settlements where order_ref = $1`,
		[orderRef],
	);
	const row = rows[0];
	if (!row?.fresh) return;
	// O custo só consta quando quem age pode lê-lo (equipe); o cliente não o vê, nem pela auditoria que ele dispara.
	const cost = await readCost(client, orderRef);
	await writeAuditEvent(client, {
		actorId: row.actor,
		action,
		targetTable: "order_settlements",
		targetId: row.id,
		metadata: {
			order_ref: orderRef,
			mode: row.mode,
			status: row.status,
			price: row.price,
			...(cost && { cost: cost.cost }),
		},
	});
}

export async function reserveOrder(client: PoolClient, input: ReserveOrderInput): Promise<SettlementResult> {
	const { quote } = input;
	const { rows } = await client.query<ResultRow>(
		"select ok, reason, status from reserve_order($1, $2, $3, $4, $5, $6::jsonb)",
		[
			input.orderRef,
			input.mode,
			input.clientProfileId,
			fromCents(quote.totalPriceCents),
			fromCents(quote.totalCostCents),
			JSON.stringify({ lines: quote.lines }),
		],
	);
	const result = toResult(rows[0]);
	if (result.ok) await auditTransition(client, input.orderRef, "settlement.reserve");
	return result;
}

export async function captureOrder(client: PoolClient, orderRef: string): Promise<SettlementResult> {
	const { rows } = await client.query<ResultRow>("select ok, reason, status from capture_order($1)", [orderRef]);
	const result = toResult(rows[0]);
	if (result.ok) await auditTransition(client, orderRef, "settlement.capture");
	return result;
}

export async function releaseOrder(client: PoolClient, orderRef: string): Promise<SettlementResult> {
	const { rows } = await client.query<ResultRow>("select ok, reason, status from release_order($1)", [orderRef]);
	const result = toResult(rows[0]);
	if (result.ok) await auditTransition(client, orderRef, "settlement.release");
	return result;
}

type SettlementRow = {
	id: string;
	order_ref: string;
	bureau_id: string;
	mode: Settlement["mode"];
	client_profile_id: string | null;
	price: string;
	status: SettlementStatus;
	created_at: Date;
	closed_at: Date | null;
};

// Custo e cotação saem só pela função order_settlement_cost (equipe do Bureau e superadmin); sem direito, sem linha.
async function readCost(client: PoolClient, orderRef: string): Promise<SettlementCost | null> {
	const { rows } = await client.query<SettlementCost>("select cost, quote from order_settlement_cost($1)", [orderRef]);
	return rows[0] ?? null;
}

export async function getSettlement(client: PoolClient, orderRef: string): Promise<Settlement | null> {
	const { rows } = await client.query<SettlementRow>(
		`select id, order_ref, bureau_id, mode, client_profile_id, price, status, created_at, closed_at
		   from order_settlements where order_ref = $1`,
		[orderRef],
	);
	const r = rows[0];
	if (!r) return null;
	const secret = await readCost(client, orderRef);
	return {
		id: r.id,
		orderRef: r.order_ref,
		bureauId: r.bureau_id,
		mode: r.mode,
		clientProfileId: r.client_profile_id,
		price: r.price,
		cost: secret?.cost ?? null,
		quote: secret?.quote ?? null,
		status: r.status,
		createdAt: r.created_at,
		closedAt: r.closed_at,
	};
}
