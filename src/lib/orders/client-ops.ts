// Operações do cliente sobre o próprio pedido (025). Cada função SQL confere a posse do pedido; aqui só há a chamada.
import type { PoolClient } from "pg";

export type OrderMemberRole = "company" | "partner" | "subject";
export type OrderMemberScrStatus = "pending" | "authorized" | "refused" | "expired";
export type OrderMember = {
	consultationId: string;
	role: OrderMemberRole;
	name: string | null;
	documentMasked: string;
	emailMasked: string | null;
	scrStatus: OrderMemberScrStatus;
	canEditEmail: boolean;
	canResend: boolean;
	changesLeft: number;
};
const MEMBER_EMAIL_FAILURES = [
	"not_found",
	"invalid_input",
	"invalid_state",
	"same_email",
	"contact_is_buyer",
	"own_account_email",
	"too_many_requests",
	"resend_too_soon",
	"resend_limit_reached",
] as const;
export type MemberEmailFailure = (typeof MEMBER_EMAIL_FAILURES)[number];

type ResultRow = { ok: boolean; reason: string | null };

// Cancela o pedido próprio e devolve a reserva ao saldo, na mesma transação.
export async function cancelMyOrder(
	client: PoolClient,
	dossierId: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" }> {
	const { rows } = await client.query<ResultRow>("select ok, reason from cancel_client_order($1)", [dossierId]);
	if (rows[0].ok) return { ok: true };
	return { ok: false, reason: rows[0].reason as "not_found" | "invalid_state" };
}

// Membros do pedido próprio, com o documento mascarado. Pedido de outro cliente devolve lista vazia.
export async function listMyOrderMembers(client: PoolClient, dossierId: string): Promise<OrderMember[]> {
	const { rows } = await client.query<{
		consultation_id: string;
		role: OrderMemberRole;
		name: string | null;
		document_masked: string;
		email_masked: string | null;
		scr_status: OrderMemberScrStatus;
		can_edit_email: boolean;
		can_resend: boolean;
		changes_left: number;
	}>(
		`select consultation_id, role, name, document_masked, email_masked, scr_status, can_edit_email, can_resend, changes_left
		   from client_order_members($1)`,
		[dossierId],
	);
	return rows.map((r) => ({
		consultationId: r.consultation_id,
		role: r.role,
		name: r.name,
		documentMasked: r.document_masked,
		emailMasked: r.email_masked,
		scrStatus: r.scr_status,
		canEditEmail: r.can_edit_email,
		canResend: r.can_resend,
		changesLeft: r.changes_left,
	}));
}

// Troca o e-mail do membro (ou só reenvia, com e-mail nulo). A função SQL confere dono, estado, limite e audita.
export async function updateMyOrderMemberEmail(
	client: PoolClient,
	input: { dossierId: string; consultationId: string; email: string | null },
): Promise<{ ok: true; authorizationId: string } | { ok: false; reason: MemberEmailFailure }> {
	const { rows } = await client.query<ResultRow & { authorization_id: string | null }>(
		"select ok, reason, authorization_id from update_my_order_member_email($1, $2, $3)",
		[input.dossierId, input.consultationId, input.email],
	);
	const row = rows[0];
	if (row.ok && row.authorization_id) return { ok: true, authorizationId: row.authorization_id };
	const reason = MEMBER_EMAIL_FAILURES.find((r) => r === row.reason);
	if (!row.ok && reason) return { ok: false, reason };
	throw new Error("unexpected updateMyOrderMemberEmail reason");
}

// Grava a declaração do comprador. Uma por pedido: a segunda gravação lança (23505) e a transação volta.
export async function recordOrderDeclaration(
	client: PoolClient,
	input: { dossierId: string; version: number; ip: string | null; userAgent: string | null },
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "outdated" }> {
	const { rows } = await client.query<ResultRow>("select ok, reason from record_order_declaration($1, $2, $3, $4)", [
		input.dossierId,
		input.version,
		input.ip,
		input.userAgent,
	]);
	if (rows[0].ok) return { ok: true };
	return { ok: false, reason: rows[0].reason as "not_found" | "outdated" };
}

// Texto vigente da declaração do comprador, para mostrar ao lado do checkbox.
export async function getCurrentDeclaration(client: PoolClient): Promise<{ version: number; title: string; bodyMd: string }> {
	const { rows } = await client.query<{ version: number; title: string; body_md: string }>(
		`select version, title, body_md from legal_documents
      where kind = 'buyer_declaration' and published_at <= now()
      order by version desc limit 1`,
	);
	if (!rows[0]) throw new Error("buyer_declaration has no published version");
	return { version: rows[0].version, title: rows[0].title, bodyMd: rows[0].body_md };
}
