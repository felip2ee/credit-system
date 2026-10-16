// Pedido de pesquisa (M6). Abertura, estado, claim e transições. O dinheiro vive em reserve_order, capture_order e
// release_order (settlement/queries.ts): aqui só se chama essas funções. Toda função recebe o PoolClient da transação
// do chamador (exceto placeOrder, que abre a sua) e grava auditoria e linha do tempo na mesma transação.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { refreshDossierStatus } from "@/lib/dossiers/queries";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { recordHolderEvent } from "@/lib/holders/queries";
import { enqueueNotification } from "@/lib/notifications/queries";
import { captureOrder, releaseOrder, reserveOrder } from "@/lib/settlement/queries";
import type { OrderQuote, SettlementFailure } from "@/lib/settlement/types";

import {
	LEASE_MINUTES,
	MAX_AI_ATTEMPTS,
	MAX_EXECUTION_ATTEMPTS,
	PAYMENT_WINDOW_DAYS,
	type AiStatus,
	type OpenOrderFailure,
	type OpenOrderInput,
	type OrderKind,
	type OrderMode,
	type OrderProductCode,
	type OrderState,
	type OrderStateReason,
} from "./types";

const OPEN_FAILURES: readonly string[] = [
	"not_allowed",
	"invalid_input",
	"product_not_for_sale",
	"addon_not_for_sale",
	"kind_mismatch",
	"self_holder_missing",
	"contact_is_buyer",
	"buyer_not_found",
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
		"select ok, reason, dossier_id, state from open_order($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)",
		[
			input.productCode,
			input.withAi,
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

// Carrega o motivo da reserva recusada para fora da transação: lançar desfaz Titular, Dossiê, pedido e autorizações.
class PlaceOrderAbort extends Error {
	constructor(readonly reason: OpenOrderFailure | SettlementFailure) {
		super("placeOrder aborted");
	}
}

// Uma transação: abre, reserva e (balcão) atualiza o estado. Saldo insuficiente não deixa Dossiê, pedido nem autorização.
export async function placeOrder(
	identity: DbIdentity,
	input: OpenOrderInput,
	quote: OrderQuote,
): Promise<{ ok: true; dossierId: string; state: OrderState } | { ok: false; reason: OpenOrderFailure | SettlementFailure }> {
	const mode: OrderMode = identity.role === "client" ? "online" : "counter";
	try {
		return await withUserTransaction(identity, async (client) => {
			const opened = await openOrder(client, input);
			if (!opened.ok) throw new PlaceOrderAbort(opened.reason);
			const reserved = await reserveOrder(client, {
				orderRef: opened.dossierId,
				mode,
				clientProfileId: mode === "online" ? identity.userId : null,
				quote,
			});
			if (!reserved.ok) throw new PlaceOrderAbort(reserved.reason);
			if (mode === "online") return { ok: true as const, dossierId: opened.dossierId, state: opened.state };
			const state = (await refreshOrderState(client, opened.dossierId)) ?? opened.state;
			return { ok: true as const, dossierId: opened.dossierId, state };
		});
	} catch (error) {
		if (error instanceof PlaceOrderAbort) return { ok: false, reason: error.reason };
		throw error;
	}
}

export async function refreshOrderState(client: PoolClient, dossierId: string): Promise<OrderState | null> {
	const { rows } = await client.query<{ state: OrderState | null }>("select refresh_order_state($1) as state", [dossierId]);
	return rows[0].state;
}

// array(...) avalia a subconsulta uma vez só: com IN (...) o Postgres a repete por linha e o limit deixa de valer.
export async function claimOrders(
	client: PoolClient,
	limit: number,
	dossierId?: string,
): Promise<{ dossierId: string; attempts: number }[]> {
	const { rows } = await client.query<{ dossier_id: string; attempts: number }>(
		`update dossier_orders o
		    set state = 'executing', lease_until = now() + make_interval(mins => $3),
		        attempts = o.attempts + 1, updated_at = now()
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
		[limit, dossierId ?? null, LEASE_MINUTES],
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
	order: { dossierId: string; mode: OrderMode; withAi: boolean; attempts: number; kind: OrderKind };
	members: ExecutionMember[];
} | null> {
	const order = await client.query<{ mode: OrderMode; with_ai: boolean; attempts: number; kind: OrderKind }>(
		`select o.mode, o.with_ai, o.attempts, d.kind::text as kind
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
		order: { dossierId, mode: o.mode, withAi: o.with_ai, attempts: o.attempts, kind: o.kind },
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

export async function completeOrder(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
): Promise<"completed" | "failed"> {
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
		    set state = 'completed', lease_until = null, ai_status = case when with_ai then 'pending' else 'none' end,
		        updated_at = now()
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
	const { rowCount } = await client.query(
		`update dossier_orders
		    set state = 'ready', lease_until = null,
		        next_attempt_at = now() + make_interval(mins => least(2 ^ ($2::int - 1), 60)::int), updated_at = now()
		  where dossier_id = $1 and state = 'executing'`,
		[dossierId, attempts],
	);
	if (rowCount === 0) throw new Error("retryOrderLater: order is not executing");
	return "ready";
}

const CANCELLABLE: readonly OrderState[] = ["awaiting_payment", "awaiting_authorization", "ready"];

export async function cancelOrder(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	reason: OrderStateReason,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_state" }> {
	const found = await client.query<{ state: OrderState }>(
		"select state from dossier_orders where dossier_id = $1 for update",
		[dossierId],
	);
	if (!found.rows[0]) return { ok: false, reason: "not_found" };
	if (!CANCELLABLE.includes(found.rows[0].state)) return { ok: false, reason: "invalid_state" };
	await releaseReservation(client, dossierId);
	await client.query(
		"update dossier_orders set state = 'cancelled', state_reason = $2, lease_until = null, updated_at = now() where dossier_id = $1",
		[dossierId, reason],
	);
	await client.query("update dossiers set status = 'cancelled' where id = $1", [dossierId]);
	await client.query(
		"update consultations set status = 'rejected' where dossier_id = $1 and status = 'pending_authorization'",
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
		`update dossier_orders set state = 'released', released_at = now(), released_by = $2, updated_at = now()
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

// Revogar não avisa o cliente. O texto do motivo fica na linha do pedido, nunca na auditoria.
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

export async function expireScrRequests(client: PoolClient, identity: DbIdentity): Promise<number> {
	const { rows } = await client.query<{ id: string; holder_id: string }>(
		`update scr_authorizations
		    set status = 'expired', auth_code = null, last_checked_at = now()
		  where bureau_id = app_bureau_id() and status = 'pending' and request_expires_at < now()
		returning id, holder_id`,
	);
	for (const row of rows) {
		await recordHolderEvent(client, identity.userId, row.holder_id, {
			eventType: "scr.expired",
			title: "Pedido de autorização SCR expirado",
		});
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "scr.expire",
			targetTable: "scr_authorizations",
			targetId: row.id,
		});
	}
	return rows.length;
}

// Cancela o que não anda mais: autorização recusada ou expirada, e balcão sem pagamento no prazo.
export async function cancelStalledOrders(client: PoolClient, identity: DbIdentity): Promise<number> {
	const { rows } = await client.query<{ dossier_id: string; reason: OrderStateReason }>(
		`select o.dossier_id,
		        case when o.state = 'awaiting_payment' then 'payment_timeout'
		             when exists (select 1 from consultations c join scr_authorizations s on s.id = c.scr_authorization_id
		                           where c.dossier_id = o.dossier_id and s.status = 'not_authorized') then 'scr_refused'
		             else 'scr_expired' end as reason
		   from dossier_orders o
		  where o.bureau_id = app_bureau_id()
		    and ((o.state = 'awaiting_payment' and o.mode = 'counter'
		          and o.created_at < now() - make_interval(days => $1))
		      or (o.state = 'awaiting_authorization'
		          and exists (select 1 from consultations c join scr_authorizations s on s.id = c.scr_authorization_id
		                       where c.dossier_id = o.dossier_id and s.status in ('not_authorized', 'expired'))))
		  order by o.created_at`,
		[PAYMENT_WINDOW_DAYS],
	);
	let cancelled = 0;
	for (const row of rows) {
		const result = await cancelOrder(client, identity, row.dossier_id, row.reason);
		if (result.ok) cancelled += 1;
	}
	return cancelled;
}

// Autorização vencida de pedido que espera: reaproveita a utilizável do mesmo escopo (Bureau, Titular, comprador) ou
// abre um pedido novo, e religa a consulta. Mesma regra do passo 10 de open_order.
async function renewExpiredAuthorizations(client: PoolClient, limit: number): Promise<void> {
	const stale = await client.query<{
		consultation_id: string;
		bureau_id: string;
		holder_id: string;
		client_profile_id: string | null;
		type: "PF" | "PJ";
		document: string;
		name: string | null;
		email: string | null;
		phone_e164: string | null;
	}>(
		`select c.id as consultation_id, s.bureau_id, s.holder_id, s.client_profile_id, s.type::text as type, s.document,
		        s.name, coalesce(s.email, c.scr_email) as email, s.phone_e164
		   from consultations c
		   join scr_authorizations s on s.id = c.scr_authorization_id
		   join dossier_orders o on o.dossier_id = c.dossier_id
		  where o.bureau_id = app_bureau_id() and o.state = 'awaiting_authorization'
		    and s.channel = 'internal' and s.status = 'authorized' and s.expires_at <= now()
		  order by o.created_at, c.id
		  limit $1`,
		[limit],
	);
	for (const row of stale.rows) {
		const usable = await client.query<{ id: string }>(
			`select s.id from scr_authorizations s
			  where s.bureau_id = $1 and s.holder_id = $2 and s.client_profile_id is not distinct from $3
			    and s.channel = 'internal'
			    and ((s.status = 'authorized' and s.expires_at > now())
			         or (s.status = 'pending' and (s.request_expires_at is null or s.request_expires_at > now())))
			  order by (s.status = 'authorized') desc, s.requested_at desc, s.id
			  limit 1`,
			[row.bureau_id, row.holder_id, row.client_profile_id],
		);
		let authorizationId = usable.rows[0]?.id;
		if (!authorizationId) {
			const created = await client.query<{ id: string }>(
				`insert into scr_authorizations
				   (bureau_id, document, type, name, email, phone_e164, holder_id, client_profile_id, consultation_id,
				    requested_by, channel)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id(), 'internal')
				 returning id`,
				[
					row.bureau_id,
					row.document,
					row.type,
					row.name,
					row.email,
					row.phone_e164,
					row.holder_id,
					row.client_profile_id,
					row.consultation_id,
				],
			);
			authorizationId = created.rows[0].id;
		}
		await client.query("update consultations set scr_authorization_id = $2 where id = $1", [row.consultation_id, authorizationId]);
	}
}

export type ScrRequestToIssue = {
	scrId: string;
	holderId: string;
	type: "PF" | "PJ";
	document: string;
	name: string;
	email: string;
	phoneE164: string | null;
};

export async function listScrRequestsToIssue(client: PoolClient, limit: number): Promise<ScrRequestToIssue[]> {
	await renewExpiredAuthorizations(client, limit);
	const { rows } = await client.query<{
		id: string;
		holder_id: string;
		type: "PF" | "PJ";
		document: string;
		name: string;
		email: string;
		phone_e164: string | null;
	}>(
		`select s.id, s.holder_id, s.type::text as type, s.document, s.name, s.email, s.phone_e164
		   from scr_authorizations s
		  where s.bureau_id = app_bureau_id() and s.channel = 'internal' and s.status = 'pending'
		    and s.auth_code is null and s.email is not null and s.name is not null
		    and (s.request_expires_at is null or s.request_expires_at > now())
		    and exists (select 1 from consultations c join dossier_orders o on o.dossier_id = c.dossier_id
		                 where c.scr_authorization_id = s.id and o.state = 'awaiting_authorization')
		  order by s.requested_at, s.id
		  limit $1`,
		[limit],
	);
	return rows.map((r) => ({
		scrId: r.id,
		holderId: r.holder_id,
		type: r.type,
		document: r.document,
		name: r.name,
		email: r.email,
		phoneE164: r.phone_e164,
	}));
}

// O tick chama refreshOrderState em cada um (passo "promover").
export async function listOrdersToPromote(client: PoolClient, limit: number): Promise<string[]> {
	const { rows } = await client.query<{ dossier_id: string }>(
		`select dossier_id from dossier_orders
		  where bureau_id = app_bureau_id() and state in ('awaiting_authorization', 'ready')
		  order by created_at limit $1`,
		[limit],
	);
	return rows.map((r) => r.dossier_id);
}

export async function listOrdersForAi(
	client: PoolClient,
	limit: number,
): Promise<{ dossierId: string; kind: OrderKind; aiAttempts: number }[]> {
	const { rows } = await client.query<{ dossier_id: string; kind: OrderKind; ai_attempts: number }>(
		`select o.dossier_id, d.kind::text as kind, o.ai_attempts
		   from dossier_orders o join dossiers d on d.id = o.dossier_id
		  where o.bureau_id = app_bureau_id() and o.state = 'completed' and o.ai_status = 'pending' and o.ai_attempts < $2
		  order by o.created_at limit $1`,
		[limit, MAX_AI_ATTEMPTS],
	);
	return rows.map((r) => ({ dossierId: r.dossier_id, kind: r.kind, aiAttempts: r.ai_attempts }));
}

export async function setAiStatus(client: PoolClient, dossierId: string, status: AiStatus, attempts: number): Promise<void> {
	await client.query(
		"update dossier_orders set ai_status = $2, ai_attempts = $3, updated_at = now() where dossier_id = $1",
		[dossierId, status, attempts],
	);
}

// Online concluído, sem parecer em andamento e nunca revogado: D20 libera sozinho.
export async function listOnlineOrdersToRelease(client: PoolClient, limit: number): Promise<string[]> {
	const { rows } = await client.query<{ dossier_id: string }>(
		`select dossier_id from dossier_orders
		  where bureau_id = app_bureau_id() and mode = 'online' and state = 'completed'
		    and ai_status <> 'pending' and revoked_at is null
		  order by created_at limit $1`,
		[limit],
	);
	return rows.map((r) => r.dossier_id);
}

export type StaffOrderView = {
	dossierId: string;
	mode: OrderMode;
	state: OrderState;
	reason: OrderStateReason | null;
	productCode: OrderProductCode;
	withAi: boolean;
	aiStatus: AiStatus;
	buyerName: string | null;
	price: string;
	paidTotal: string | null;
	releasedAt: Date | null;
	revokedAt: Date | null;
	revokeReason: string | null;
	createdAt: Date;
};

export async function getStaffOrder(client: PoolClient, dossierId: string): Promise<StaffOrderView | null> {
	const { rows } = await client.query<{
		dossier_id: string;
		mode: OrderMode;
		state: OrderState;
		state_reason: OrderStateReason | null;
		product_code: OrderProductCode;
		with_ai: boolean;
		ai_status: AiStatus;
		buyer_name: string | null;
		price: string | null;
		paid_total: string | null;
		released_at: Date | null;
		revoked_at: Date | null;
		revoke_reason: string | null;
		created_at: Date;
	}>(
		`select o.dossier_id, o.mode, o.state, o.state_reason, o.product_code, o.with_ai, o.ai_status,
		        p.full_name as buyer_name, s.price::text as price,
		        case when o.mode = 'counter' then
		          (select coalesce(sum(cp.amount), 0)::text from counter_payments cp
		            where cp.dossier_id = o.dossier_id and cp.voided_at is null) end as paid_total,
		        o.released_at, o.revoked_at, o.revoke_reason, o.created_at
		   from dossier_orders o
		   left join profiles p on p.id = o.client_profile_id
		   left join order_settlements s on s.order_ref = o.dossier_id
		  where o.dossier_id = $1`,
		[dossierId],
	);
	const r = rows[0];
	if (!r) return null;
	return {
		dossierId: r.dossier_id,
		mode: r.mode,
		state: r.state,
		reason: r.state_reason,
		productCode: r.product_code,
		withAi: r.with_ai,
		aiStatus: r.ai_status,
		buyerName: r.buyer_name,
		price: r.price ?? "0.00",
		paidTotal: r.paid_total,
		releasedAt: r.released_at,
		revokedAt: r.revoked_at,
		revokeReason: r.revoke_reason,
		createdAt: r.created_at,
	};
}
