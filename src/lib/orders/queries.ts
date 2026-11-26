// Pedido de pesquisa (M6). Abertura, estado, claim e transições. O dinheiro vive em reserve_order, capture_order e
// release_order (settlement/queries.ts): aqui só se chama essas funções. Toda função recebe o PoolClient da transação
// do chamador (exceto placeOrder, que abre a sua) e grava auditoria e linha do tempo na mesma transação.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { beginCouponAttempt, clearCouponAttempt, holdCouponSlot } from "@/lib/coupons/attempt-slot";
import { computeCouponDiscount, eligibleTotalCents } from "@/lib/coupons/discount";
import { previewCoupon } from "@/lib/coupons/queries";
import { refreshDossierStatus } from "@/lib/dossiers/queries";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { recordHolderEvent } from "@/lib/holders/queries";
import { enqueueNotification } from "@/lib/notifications/queries";
import { captureOrder, releaseOrder, reserveOrder } from "@/lib/settlement/queries";
import type { OrderQuote, SettlementFailure } from "@/lib/settlement/types";
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from "@/lib/validators/wallet";

import { recordOrderDeclaration } from "./client-ops";
import { insertOrderPixQuote } from "./order-pix";
import {
	LEASE_MINUTES,
	MAX_EXECUTION_ATTEMPTS,
	type AiStatus,
	type OpenOrderFailure,
	type OpenOrderInput,
	type OrderKind,
	type OrderMode,
	type OrderState,
	type OrderStateReason,
} from "./types";

const OPEN_FAILURES: readonly string[] = [
	"not_allowed",
	"invalid_input",
	"product_not_for_sale",
	"kind_mismatch",
	"third_party_not_allowed",
	"self_holder_missing",
	"contact_is_buyer",
	"buyer_not_found",
	"too_many_requests",
	"too_many_orders",
];
const MAX_REVOKE_REASON = 500;

type OpenResult = { ok: true; dossierId: string; state: OrderState } | { ok: false; reason: OpenOrderFailure };

export async function openOrder(client: PoolClient, input: OpenOrderInput): Promise<OpenResult> {
	const partners = input.partners.map((p) => ({
		document: p.documentDigits,
		name: p.name,
		email: p.email,
		percentage: p.percentage,
		role: p.role,
	}));
	const { rows } = await client.query<{ ok: boolean; reason: string | null; dossier_id: string | null; state: OrderState | null }>(
		"select ok, reason, dossier_id, state from open_order($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)",
		[
			input.productCode,
			input.self,
			input.subject?.type ?? null,
			input.subject?.name ?? null,
			input.subject?.documentDigits ?? null,
			JSON.stringify(partners),
			input.contact.email,
			input.contact.phoneE164,
			input.buyerProfileId,
		],
	);
	const row = rows[0];
	if (row.ok && row.dossier_id && row.state) return { ok: true, dossierId: row.dossier_id, state: row.state };
	if (!row.ok && row.reason && OPEN_FAILURES.includes(row.reason)) return { ok: false, reason: row.reason as OpenOrderFailure };
	throw new Error("unexpected openOrder reason");
}

export type PlaceOrderFailure =
	| OpenOrderFailure
	| SettlementFailure
	| "declaration_outdated"
	| "pix_amount_above_limit"
	| "pix_amount_below_minimum"
	| "too_many_awaiting_payment";
export type PlaceOrderOptions = {
	declaration?: { version: number; ip: string | null; userAgent: string | null };
	// Só pedido online. O desconto é calculado aqui, na mesma transação da reserva; o banco confere o preço pago.
	couponCode?: string;
};

// Carrega o motivo da reserva recusada para fora da transação: lançar desfaz Titular, Dossiê, pedido e autorizações.
class PlaceOrderAbort extends Error {
	constructor(readonly reason: PlaceOrderFailure) {
		super("placeOrder aborted");
	}
}

// Cada pedido aguardando pagamento pode gerar uma cobrança real no Asaas e um pedido de autorização SCR: sem teto, um
// cliente sem saldo abriria vários de graça. Abaixo do teto diário de pedidos online (5, em open_order).
export const MAX_AWAITING_PAYMENT_ORDERS = 3;

const CODE_VALID_FAILURES: readonly PlaceOrderFailure[] = [
	"coupon_funds_insufficient",
	"pix_amount_above_limit",
	"pix_amount_below_minimum",
	"too_many_awaiting_payment",
];

// Cupom inválido por qualquer motivo (inclusive pedido de balcão, que não usa cupom) é o mesmo motivo: não revela qual.
async function resolveCoupon(
	client: PoolClient,
	code: string,
	quote: OrderQuote,
): Promise<{ code: string; discountCents: number }> {
	const productCodes = Array.from(new Set(quote.lines.map((l) => l.code)));
	const preview = await previewCoupon(client, code, productCodes);
	if (!preview) throw new PlaceOrderAbort("coupon_invalid");
	const { discountCents } = computeCouponDiscount({
		kind: preview.kind,
		value: preview.value,
		eligibleTotalCents: eligibleTotalCents(quote.lines, preview.eligibleProductCodes),
	});
	return { code, discountCents };
}

// Uma transação: abre, grava a declaração (portal), reserva e atualiza o estado. Online sem saldo para o preço pago:
// o pedido fica em awaiting_payment com o preço e o cupom em order_pix_quotes (pixPriceCents); o PIX é criado depois.
// Qualquer outra recusa (declaração, cupom, preço, faixa do PIX) não deixa Dossiê, pedido nem autorização.
export async function placeOrder(
	identity: DbIdentity,
	input: OpenOrderInput,
	quote: OrderQuote,
	options: PlaceOrderOptions = {},
): Promise<
	{ ok: true; dossierId: string; state: OrderState; pixPriceCents?: number } | { ok: false; reason: PlaceOrderFailure }
> {
	const mode: OrderMode = identity.role === "client" ? "online" : "counter";
	// Cupom no pedido online: a tentativa é contada antes de avaliar o código (054). No limite ou com erro, recusa sem tocar no pedido.
	const slot = options.couponCode && mode === "online" ? await beginCouponAttempt(identity) : undefined;
	if (slot === null) return { ok: false, reason: "coupon_invalid" };
	try {
		const placed = await withUserTransaction(identity, async (client) => {
			if (slot) await holdCouponSlot(client, slot);
			const opened = await openOrder(client, input);
			if (!opened.ok) throw new PlaceOrderAbort(opened.reason);
			if (options.declaration) {
				const declared = await recordOrderDeclaration(client, { dossierId: opened.dossierId, ...options.declaration });
				if (!declared.ok) throw new PlaceOrderAbort(declared.reason === "outdated" ? "declaration_outdated" : "not_found");
			}
			const coupon = options.couponCode ? await resolveCoupon(client, options.couponCode, quote) : undefined;
			const reserved = await reserveOrder(client, {
				orderRef: opened.dossierId,
				mode,
				clientProfileId: mode === "online" ? identity.userId : null,
				quote,
				coupon,
			});
			if (!reserved.ok) {
				// Online sem saldo: o pedido espera o PIX (abordagem A). Qualquer outra recusa desfaz tudo, como antes.
				if (mode !== "online" || reserved.reason !== "insufficient_balance") throw new PlaceOrderAbort(reserved.reason);
				const priceCents = quote.totalPriceCents - (coupon?.discountCents ?? 0);
				if (priceCents > MAX_TOPUP_CENTS) throw new PlaceOrderAbort("pix_amount_above_limit");
				if (priceCents < MIN_TOPUP_CENTS) throw new PlaceOrderAbort("pix_amount_below_minimum");
				// open_order segura o lock do cliente até o fim desta transação: pedidos paralelos contam um por vez.
				// A contagem inclui o pedido recém-aberto (já está em awaiting_payment).
				if ((await countAwaitingPaymentOrders(client, identity.userId)) > MAX_AWAITING_PAYMENT_ORDERS) {
					throw new PlaceOrderAbort("too_many_awaiting_payment");
				}
				await insertOrderPixQuote(client, { dossierId: opened.dossierId, priceCents, couponCode: coupon?.code ?? null });
				return { ok: true as const, dossierId: opened.dossierId, state: "awaiting_payment" as const, pixPriceCents: priceCents };
			}
			// O gatilho de order_settlements (064) já avançou o pedido online; o cliente não executa refresh_order_state
			// (for update sem direito de update), então lê o estado.
			const state = mode === "online" ? await readOrderState(client, opened.dossierId) : await refreshOrderState(client, opened.dossierId);
			return { ok: true as const, dossierId: opened.dossierId, state: state ?? opened.state };
		});
		if (slot) await clearCouponAttempt(identity, slot);
		return placed;
	} catch (error) {
		if (error instanceof PlaceOrderAbort) {
			// Só o sucesso e as recusas que não são erro de código (fundos do Bureau, faixa do PIX) devolvem a vaga; o resto conta.
			if (slot && CODE_VALID_FAILURES.includes(error.reason)) await clearCouponAttempt(identity, slot);
			return { ok: false, reason: error.reason };
		}
		throw error;
	}
}

async function countAwaitingPaymentOrders(client: PoolClient, clientProfileId: string): Promise<number> {
	const { rows } = await client.query<{ total: number }>(
		"select count(*)::int as total from dossier_orders where client_profile_id = $1 and mode = 'online' and state = 'awaiting_payment'",
		[clientProfileId],
	);
	return rows[0].total;
}

async function readOrderState(client: PoolClient, dossierId: string): Promise<OrderState | null> {
	const { rows } = await client.query<{ state: OrderState }>("select state from dossier_orders where dossier_id = $1", [dossierId]);
	return rows[0]?.state ?? null;
}

export async function refreshOrderState(client: PoolClient, dossierId: string): Promise<OrderState | null> {
	const { rows } = await client.query<{ state: OrderState | null }>("select refresh_order_state($1) as state", [dossierId]);
	return rows[0].state;
}

// Teto da coluna attempts (check 0..20): a retomada de lease vencida não pode estourá-lo e derrubar o claim do Bureau.
const ATTEMPTS_COLUMN_MAX = 20;

// array(...) avalia a subconsulta uma vez só: com IN (...) o Postgres a repete por linha e o limit deixa de valer.
export async function claimOrders(
	client: PoolClient,
	limit: number,
	dossierId?: string,
): Promise<{ dossierId: string; attempts: number }[]> {
	const { rows } = await client.query<{ dossier_id: string; attempts: number }>(
		`update dossier_orders o
		    set state = 'executing', lease_until = now() + make_interval(mins => $3),
		        attempts = least(o.attempts + 1, $4), updated_at = now()
		  where o.dossier_id = any (array(
		    select q.dossier_id from dossier_orders q
		     where q.bureau_id = app_bureau_id()
		       and ((q.state = 'ready' and (q.next_attempt_at is null or q.next_attempt_at <= now()))
		            or (q.state = 'executing' and q.lease_until < now()))
		       and ($2::uuid is null or q.dossier_id = $2)
		     order by q.created_at
		     limit $1
		     for update skip locked))
		 returning o.dossier_id, o.attempts`,
		[limit, dossierId ?? null, LEASE_MINUTES, ATTEMPTS_COLUMN_MAX],
	);
	return rows.map((r) => ({ dossierId: r.dossier_id, attempts: r.attempts }));
}

export type ExecutionMember = {
	consultationId: string;
	type: "PF" | "PJ";
	document: string;
	name: string | null;
	product: string;
	holderId: string;
	status: string;
	scrEmail: string | null;
	isMain: boolean;
};

export async function getExecutionPlan(
	client: PoolClient,
	dossierId: string,
): Promise<{
	order: { dossierId: string; mode: OrderMode; attempts: number; kind: OrderKind };
	members: ExecutionMember[];
} | null> {
	const order = await client.query<{ mode: OrderMode; attempts: number; kind: OrderKind }>(
		`select o.mode, o.attempts, d.kind::text as kind
		   from dossier_orders o join dossiers d on d.id = o.dossier_id
		  where o.dossier_id = $1`,
		[dossierId],
	);
	if (!order.rows[0]) return null;
	const members = await client.query<{
		id: string;
		type: "PF" | "PJ";
		document: string;
		document_name: string | null;
		product: string;
		holder_id: string;
		status: string;
		scr_email: string | null;
		is_main: boolean;
	}>(
		`select c.id, c.type::text as type, c.document, c.document_name, c.product, c.holder_id, c.status::text as status,
		        c.scr_email, (c.holder_id = d.holder_id) as is_main
		   from consultations c join dossiers d on d.id = c.dossier_id
		  where c.dossier_id = $1
		  order by (c.holder_id = d.holder_id) desc, c.document, c.id`,
		[dossierId],
	);
	const o = order.rows[0];
	return {
		order: { dossierId, mode: o.mode, attempts: o.attempts, kind: o.kind },
		members: members.rows.map((m) => ({
			consultationId: m.id,
			type: m.type,
			document: m.document,
			name: m.document_name,
			product: m.product,
			holderId: m.holder_id,
			status: m.status,
			scrEmail: m.scr_email,
			isMain: m.is_main,
		})),
	};
}

async function holderOf(client: PoolClient, dossierId: string): Promise<string | null> {
	const { rows } = await client.query<{ holder_id: string }>("select holder_id from dossiers where id = $1", [dossierId]);
	return rows[0]?.holder_id ?? null;
}

// Linha do tempo do Titular e auditoria da transição, sem documento, nome nem contato.
async function recordTransition(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	event: { audit: string; timeline: string; title: string; metadata?: Record<string, unknown> },
): Promise<void> {
	const holderId = await holderOf(client, dossierId);
	if (holderId) {
		await recordHolderEvent(client, identity.userId, holderId, {
			eventType: event.timeline,
			title: event.title,
			metadata: { dossier_id: dossierId },
		});
	}
	await writeAuditEvent(client, {
		actorId: identity.userId,
		action: event.audit,
		targetTable: "dossier_orders",
		targetId: dossierId,
		metadata: event.metadata ?? {},
	});
}

async function closeAsFailed(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	reason: OrderStateReason,
): Promise<void> {
	const { rowCount } = await client.query(
		`update dossier_orders set state = 'failed', state_reason = $2, lease_until = null, updated_at = now()
		  where dossier_id = $1 and state = 'executing'`,
		[dossierId, reason],
	);
	if (rowCount === 0) throw new Error("failOrder: order is not executing");
	await refreshDossierStatus(client, dossierId);
	await recordTransition(client, identity, dossierId, {
		audit: "order.fail",
		timeline: "order.failed",
		title: "Pesquisa não concluída",
		metadata: { reason },
	});
}

async function releaseReservation(client: PoolClient, dossierId: string): Promise<void> {
	const released = await releaseOrder(client, dossierId);
	if (!released.ok) throw new Error(`release failed: ${released.reason}`);
}

// Ordem global de travas: pedido -> liquidação -> carteira. A captura e a liberação travam a liquidação e a carteira;
// travar o pedido antes evita o impasse com o estorno do PIX (apply_asaas_payment), que segue a mesma ordem.
async function lockOrder(client: PoolClient, dossierId: string): Promise<void> {
	await client.query("select 1 from dossier_orders where dossier_id = $1 for update", [dossierId]);
}

export async function completeOrder(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
): Promise<"completed" | "failed"> {
	await lockOrder(client, dossierId);
	const captured = await captureOrder(client, dossierId);
	// Falha da captura lança: a transação volta, a lease vence e o tick tenta de novo.
	if (!captured.ok) throw new Error(`capture failed: ${captured.reason}`);
	// Estorno de PIX retomou a reserva: o fechamento já está gravado, então não há nova liberação.
	if (captured.clawedBack) {
		await closeAsFailed(client, identity, dossierId, "reservation_clawed_back");
		return "failed";
	}
	const { rowCount } = await client.query(
		`update dossier_orders
		    set state = 'completed', lease_until = null, updated_at = now()
		  where dossier_id = $1 and state = 'executing'`,
		[dossierId],
	);
	if (rowCount === 0) throw new Error("completeOrder: order is not executing");
	await recordTransition(client, identity, dossierId, {
		audit: "order.complete",
		timeline: "order.completed",
		title: "Pesquisa concluída",
	});
	return "completed";
}

export async function failOrder(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	reason: OrderStateReason,
): Promise<void> {
	await lockOrder(client, dossierId);
	await releaseReservation(client, dossierId);
	await closeAsFailed(client, identity, dossierId, reason);
}

// Recuo exponencial: 1, 2, 4, 8 minutos, no máximo 60. Na quinta tentativa a reserva é liberada.
export async function retryOrderLater(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	attempts: number,
): Promise<"ready" | "failed"> {
	if (attempts >= MAX_EXECUTION_ATTEMPTS) {
		await failOrder(client, identity, dossierId, "deps_unavailable");
		return "failed";
	}
	const { rows } = await client.query<{ next_attempt_at: Date }>(
		`update dossier_orders
		    set state = 'ready', lease_until = null,
		        next_attempt_at = now() + make_interval(mins => least(2 ^ ($2::int - 1), 60)::int), updated_at = now()
		  where dossier_id = $1 and state = 'executing'
		returning next_attempt_at`,
		[dossierId, attempts],
	);
	if (!rows[0]) throw new Error("retryOrderLater: order is not executing");
	await writeAuditEvent(client, {
		actorId: identity.userId,
		action: "order.retry",
		targetTable: "dossier_orders",
		targetId: dossierId,
		metadata: { attempts, next_attempt_at: rows[0].next_attempt_at.toISOString() },
	});
	return "ready";
}

const CANCELLABLE: readonly OrderState[] = ["awaiting_payment", "awaiting_authorization", "ready"];

export async function cancelOrder(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	reason: OrderStateReason,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" }> {
	const found = await client.query<{ state: OrderState; mode: OrderMode }>(
		"select state, mode from dossier_orders where dossier_id = $1 for update",
		[dossierId],
	);
	const order = found.rows[0];
	if (!order) return { ok: false, reason: "not_found" };
	if (!CANCELLABLE.includes(order.state)) return { ok: false, reason: "invalid_state" };
	// Pedido online que espera o PIX ainda não tem liquidação: não há reserva a liberar.
	if (order.mode === "online" && order.state === "awaiting_payment") {
		const released = await releaseOrder(client, dossierId);
		if (!released.ok && released.reason !== "not_found") throw new Error(`release failed: ${released.reason}`);
	} else {
		await releaseReservation(client, dossierId);
	}
	await client.query(
		"update dossier_orders set state = 'cancelled', state_reason = $2, lease_until = null, updated_at = now() where dossier_id = $1",
		[dossierId, reason],
	);
	await client.query("update dossiers set status = 'cancelled' where id = $1", [dossierId]);
	await client.query(
		"update consultations set status = 'rejected' where dossier_id = $1 and status in ('pending_authorization', 'processing')",
		[dossierId],
	);
	// Links já enviados deixam de valer: autorização pendente que nenhuma outra consulta viva usa passa a 'expired'.
	await client.query(
		`update scr_authorizations s
		    set status = 'expired', auth_code = null, last_checked_at = now()
		  where s.status = 'pending'
		    and s.id in (select c.scr_authorization_id from consultations c where c.dossier_id = $1)
		    and not exists (select 1 from consultations c2
		                     where c2.scr_authorization_id = s.id and c2.dossier_id <> $1
		                       and c2.status in ('pending_authorization', 'authorized', 'processing'))`,
		[dossierId],
	);
	await recordTransition(client, identity, dossierId, {
		audit: "order.cancel",
		timeline: "order.cancelled",
		title: "Pedido de pesquisa cancelado",
		metadata: { reason },
	});
	return { ok: true };
}

const firstName = (fullName: string): string => fullName.trim().split(/\s+/)[0] || "cliente";

// D22: e-mail sempre; WhatsApp só no canal escolhido e com celular confirmado. A chave leva o canal e o instante da liberação.
async function enqueueReleaseNotices(
	client: PoolClient,
	identity: DbIdentity,
	input: { dossierId: string; buyerId: string; releasedAtMs: number; siteUrl: string },
): Promise<void> {
	const { rows } = await client.query<{
		full_name: string;
		email: string;
		phone_e164: string | null;
		phone_verified_at: Date | null;
		notification_channel: "email" | "whatsapp";
	}>("select full_name, email, phone_e164, phone_verified_at, notification_channel from profiles where id = $1", [
		input.buyerId,
	]);
	const buyer = rows[0];
	const params = {
		clientName: firstName(buyer.full_name),
		url: `${input.siteUrl.replace(/\/+$/, "")}/portal/pesquisas/${input.dossierId}`,
	};
	const channels: { channel: "email" | "whatsapp"; recipient: string }[] = [{ channel: "email", recipient: buyer.email }];
	if (buyer.notification_channel === "whatsapp" && buyer.phone_verified_at && buyer.phone_e164) {
		channels.push({ channel: "whatsapp", recipient: buyer.phone_e164 });
	}
	for (const { channel, recipient } of channels) {
		const result = await enqueueNotification(client, identity, {
			templateKey: "research_released",
			channel,
			recipient,
			params,
			idempotencyKey: `research_released:${channel}:${input.dossierId}:${input.releasedAtMs}`,
			reference: `order:${input.dossierId}`,
		});
		if (!result.ok) throw new Error(`unexpected releaseDelivery enqueue reason: ${result.reason}`);
	}
}

export async function releaseDelivery(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	siteUrl: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" | "no_buyer" }> {
	const found = await client.query<{ state: OrderState; ai_status: AiStatus; client_profile_id: string | null }>(
		"select state, ai_status, client_profile_id from dossier_orders where dossier_id = $1 for update",
		[dossierId],
	);
	const order = found.rows[0];
	if (!order) return { ok: false, reason: "not_found" };
	if (order.state !== "completed" || order.ai_status === "pending") return { ok: false, reason: "invalid_state" };
	if (!order.client_profile_id) return { ok: false, reason: "no_buyer" };
	const released = await client.query<{ released_ms: string }>(
		`update dossier_orders
		    set state = 'released', released_at = now(), released_by = $2, updated_at = now(),
		        revoked_at = null, revoked_by = null, revoke_reason = null
		  where dossier_id = $1
		returning floor(extract(epoch from released_at) * 1000)::text as released_ms`,
		[dossierId, identity.userId],
	);
	await recordTransition(client, identity, dossierId, {
		audit: "order.release",
		timeline: "order.released",
		title: "Pesquisa liberada ao cliente",
	});
	await enqueueReleaseNotices(client, identity, {
		dossierId,
		buyerId: order.client_profile_id,
		releasedAtMs: Number(released.rows[0].released_ms),
		siteUrl,
	});
	return { ok: true };
}

// Revogar não avisa o cliente. O texto do motivo fica na linha do pedido, nunca na auditoria. Liberar de novo é legítimo
// e limpa a revogação (releaseDelivery).
export async function revokeDelivery(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	reason: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" }> {
	const text = reason.trim();
	if (text.length < 1 || text.length > MAX_REVOKE_REASON) {
		throw new Error(`revokeDelivery: reason must have 1 to ${MAX_REVOKE_REASON} characters`);
	}
	const found = await client.query<{ state: OrderState }>(
		"select state from dossier_orders where dossier_id = $1 for update",
		[dossierId],
	);
	if (!found.rows[0]) return { ok: false, reason: "not_found" };
	if (found.rows[0].state !== "released") return { ok: false, reason: "invalid_state" };
	await client.query(
		`update dossier_orders
		    set state = 'completed', revoked_at = now(), revoked_by = $2, revoke_reason = $3, updated_at = now()
		  where dossier_id = $1`,
		[dossierId, identity.userId, text],
	);
	await recordTransition(client, identity, dossierId, {
		audit: "order.revoke",
		timeline: "order.revoked",
		title: "Liberação da pesquisa revogada",
	});
	return { ok: true };
}
