// Operações do cliente sobre o próprio pedido (025). Cada função SQL confere a posse do pedido; aqui só há a chamada.
import type { PoolClient } from "pg";

export type OrderMemberRole = "company" | "partner" | "subject";
export type OrderMemberScrStatus = "pending" | "authorized" | "refused" | "expired";
export type OrderMember = {
	role: OrderMemberRole;
	name: string | null;
	documentMasked: string;
	scrStatus: OrderMemberScrStatus;
};

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
		role: OrderMemberRole;
		name: string | null;
		document_masked: string;
		scr_status: OrderMemberScrStatus;
	}>("select role, name, document_masked, scr_status from client_order_members($1)", [dossierId]);
	return rows.map((r) => ({ role: r.role, name: r.name, documentMasked: r.document_masked, scrStatus: r.scr_status }));
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

// Versão vigente do texto da declaração (legal_documents é público para leitura).
export async function currentDeclarationVersion(client: PoolClient): Promise<number> {
	const { rows } = await client.query<{ version: number | null }>(
		"select max(version) as version from legal_documents where kind = 'buyer_declaration' and published_at <= now()",
	);
	if (rows[0].version === null) throw new Error("buyer_declaration has no published version");
	return rows[0].version;
}
