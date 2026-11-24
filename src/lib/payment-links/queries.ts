// Link de pagamento /pagar/<token> (spec 2026-11-24, parte 3). Só o hash SHA-256 do token fica no banco.
// Nada aqui grava em log, auditoria ou erro: token, hash ou CPF/CNPJ completo.
import { writeAuditEvent } from "@/lib/audit/write";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

import { generateToken, hashToken, PAYMENT_LINK_TOKEN_PATTERN } from "./token";

export const PAYMENT_LINK_VALIDITY_DAYS = 7;

const PRODUCT_NAMES: Record<string, string> = {
	dossie_pf: "Dossiê Pessoa Física",
	dossie_empresarial: "Dossiê Empresarial",
};

export type CreatePaymentLinkResult =
	| { ok: true; id: string; token: string; expiresAt: Date }
	| { ok: false; reason: "not_found" | "not_payable" | "already_paid" };

// Um link ativo por pedido. O token em claro só existe na criação: um segundo "Gerar link" não tem como devolver o
// primeiro. Por isso a segunda chamada cancela o link ativo (vencido ou não) e emite outro, na mesma transação. O link
// antigo deixa de abrir; o novo é o único ativo. Pedido de outro Bureau não aparece (RLS): not_found.
export async function createPaymentLink(identity: DbIdentity, orderId: string): Promise<CreatePaymentLinkResult> {
	return withUserTransaction(identity, async (client) => {
		// Serializa os cliques do mesmo pedido: sem isso o segundo insert esbarraria no índice parcial (23505).
		await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`payment-link:${orderId}`]);

		const order = await client.query<{ mode: string; state: string }>(
			"select mode, state from dossier_orders where dossier_id = $1 and bureau_id = app_bureau_id()",
			[orderId],
		);
		if (!order.rows[0]) return { ok: false, reason: "not_found" };
		// Pedido online é pago pela carteira do cliente; só o de balcão aguardando pagamento ganha link.
		if (order.rows[0].mode !== "counter" || order.rows[0].state !== "awaiting_payment") {
			return { ok: false, reason: "not_payable" };
		}
		const paid = await client.query("select 1 from payment_links where order_id = $1 and status = 'paid'", [orderId]);
		if (paid.rows.length > 0) return { ok: false, reason: "already_paid" };

		const cancelled = await client.query(
			"update payment_links set status = 'cancelled' where order_id = $1 and status = 'active' returning id",
			[orderId],
		);
		const { token, hash } = generateToken();
		const { rows } = await client.query<{ id: string; expires_at: Date }>(
			`insert into payment_links (bureau_id, order_id, token_hash, expires_at, created_by)
			 values (app_bureau_id(), $1, $2, now() + make_interval(days => $3), app_user_id())
			 returning id, expires_at`,
			[orderId, hash, PAYMENT_LINK_VALIDITY_DAYS],
		);
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "payment_link.create",
			targetTable: "payment_links",
			targetId: rows[0].id,
			metadata: { order_id: orderId, replaced: cancelled.rows.length > 0 },
		});
		return { ok: true, id: rows[0].id, token, expiresAt: rows[0].expires_at };
	});
}

export type PaymentLinkSummary = {
	bureauName: string;
	productName: string;
	// Reais com 2 casas (numeric do Postgres).
	amount: string;
	// Sempre a forma mascarada do pedido; o banco nunca devolve o documento completo.
	maskedDocument: string;
};

export type ResolvedPaymentLink =
	| {
			ok: true;
			summary: PaymentLinkSummary;
			// Para a página criar a cobrança do pedido certo. Nunca vai ao navegador.
			link: { id: string; orderId: string; bureauId: string };
	  }
	| { ok: false; reason: "invalid" | "expired" | "paid" };

type LinkRow = {
	link_id: string;
	bureau_id: string;
	order_id: string;
	status: "active" | "paid" | "expired" | "cancelled";
	expires_at: Date;
	bureau_name: string;
	product_code: string;
	subject_document_masked: string;
	amount: string | null;
};

// Rota pública, sem sessão: a função SECURITY DEFINER é a única porta de leitura. Ela não filtra status nem validade;
// quem decide é esta função. Token fora do formato ou desconhecido = "invalid" (a página não diz qual dos dois).
export async function resolvePaymentLink(token: string): Promise<ResolvedPaymentLink> {
	if (!PAYMENT_LINK_TOKEN_PATTERN.test(token)) return { ok: false, reason: "invalid" };
	const { rows } = await pool.query<LinkRow>("select * from public_payment_link_by_hash($1)", [hashToken(token)]);
	const row = rows[0];
	if (!row) return { ok: false, reason: "invalid" };
	if (row.status === "paid") return { ok: false, reason: "paid" };
	if (row.status !== "active" || row.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" };
	// Pedido sem liquidação (sem preço) não gera cobrança.
	if (row.amount === null) return { ok: false, reason: "invalid" };
	return {
		ok: true,
		summary: {
			bureauName: row.bureau_name,
			productName: PRODUCT_NAMES[row.product_code] ?? "Consulta",
			amount: row.amount,
			maskedDocument: row.subject_document_masked,
		},
		link: { id: row.link_id, orderId: row.order_id, bureauId: row.bureau_id },
	};
}

export type PaymentLinkListItem = {
	id: string;
	orderId: string;
	status: "active" | "paid" | "expired" | "cancelled";
	expiresAt: Date;
	createdAt: Date;
	productName: string;
	holderName: string;
	maskedDocument: string;
	// Reais com 2 casas; nulo se o pedido não tem liquidação.
	amount: string | null;
};

const LIST_LIMIT = 50;

// Cobranças do Bureau do chamador (RLS), mais novas primeiro. Nunca devolve token nem hash: a URL em claro não existe mais.
export async function listPaymentLinks(identity: DbIdentity): Promise<PaymentLinkListItem[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{
			id: string;
			order_id: string;
			status: PaymentLinkListItem["status"];
			expires_at: Date;
			created_at: Date;
			product_code: string;
			subject_name: string;
			subject_document_masked: string;
			amount: string | null;
		}>(
			`select l.id, l.order_id, l.status, l.expires_at, l.created_at, o.product_code, o.subject_name,
			        o.subject_document_masked, s.price::text as amount
			   from payment_links l
			   join dossier_orders o on o.dossier_id = l.order_id
			   left join order_settlements s on s.order_ref = l.order_id
			  where l.bureau_id = app_bureau_id()
			  order by l.created_at desc
			  limit $1`,
			[LIST_LIMIT],
		);
		return rows.map((r) => ({
			id: r.id,
			orderId: r.order_id,
			status: r.status,
			expiresAt: r.expires_at,
			createdAt: r.created_at,
			productName: PRODUCT_NAMES[r.product_code] ?? "Consulta",
			holderName: r.subject_name,
			maskedDocument: r.subject_document_masked,
			amount: r.amount,
		}));
	});
}
