// Correção do contato do pedido de autorização SCR (044). A função SQL troca o contato, invalida o link antigo e grava a
// auditoria (e-mail mascarado) na mesma transação; aqui ficam a chamada e a montagem do pedido a emitir.
import type { PoolClient } from "pg";

import type { ScrRequestToIssue } from "./tick-queries";
import type { UpdateContactFailure } from "./types";

const UPDATE_FAILURES: readonly string[] = [
	"not_allowed",
	"invalid_input",
	"not_found",
	"invalid_state",
	"contact_is_buyer",
	"too_many_requests",
	"resend_too_soon",
	"contact_limit_reached",
];

export type UpdateOrderContactInput = {
	dossierId: string;
	consultationId: string;
	email: string | null;
	phoneE164: string | null;
};

// `request` é o pedido a emitir para o contato novo; nulo quando a autorização não tem nome ou e-mail (o tick decide) ou
// quando o pedido espera o pagamento (`deferred`): aí o contato só é gravado e a emissão é do tick depois do pagamento.
export type UpdateOrderContactResult =
	| { ok: true; request: ScrRequestToIssue | null; deferred: boolean }
	| { ok: false; reason: UpdateContactFailure };

export async function updateOrderContact(
	client: PoolClient,
	input: UpdateOrderContactInput,
): Promise<UpdateOrderContactResult> {
	const { rows } = await client.query<{ ok: boolean; reason: string | null; authorization_id: string | null; order_state: string | null }>(
		"select ok, reason, authorization_id, order_state from update_order_contact($1, $2, $3, $4)",
		[input.dossierId, input.consultationId, input.email, input.phoneE164],
	);
	const row = rows[0];
	if (!row.ok) {
		if (row.reason && UPDATE_FAILURES.includes(row.reason)) return { ok: false, reason: row.reason as UpdateContactFailure };
		throw new Error("unexpected updateOrderContact reason");
	}
	if (row.order_state === "awaiting_payment") return { ok: true, request: null, deferred: true };
	const issued = await client.query<{
		id: string;
		public_token: string;
		holder_id: string;
		type: "PF" | "PJ";
		document: string;
		name: string | null;
		email: string | null;
		phone_e164: string | null;
	}>(
		"select id, public_token::text, holder_id, type::text as type, document, name, email, phone_e164 from scr_authorizations where id = $1",
		[row.authorization_id],
	);
	const auth = issued.rows[0];
	if (!auth.email || !auth.name) return { ok: true, request: null, deferred: false };
	return {
		ok: true,
		deferred: false,
		request: {
			scrId: auth.id,
			publicToken: auth.public_token,
			holderId: auth.holder_id,
			type: auth.type,
			document: auth.document,
			name: auth.name,
			email: auth.email,
			phoneE164: auth.phone_e164,
		},
	};
}
