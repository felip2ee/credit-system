// Passos do tick dos pedidos (M6): expirar, cancelar, renovar e listar o que cada passo trata. Toda função recebe o
// PoolClient da transação do chamador e grava auditoria e linha do tempo na mesma transação.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import type { DbIdentity } from "@/lib/db/transaction";
import { recordHolderEvent } from "@/lib/holders/queries";

import { cancelOrder } from "./queries";
import { LEASE_MINUTES, MAX_AI_ATTEMPTS, PAYMENT_WINDOW_DAYS, SCR_REQUEST_DAYS, type AiStatus, type OrderKind, type OrderStateReason } from "./types";

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

async function markAuthorizationExpired(client: PoolClient, identity: DbIdentity, id: string, holderId: string): Promise<void> {
	await client.query("update scr_authorizations set status = 'expired', auth_code = null, last_checked_at = now() where id = $1", [id]);
	await recordHolderEvent(client, identity.userId, holderId, {
		eventType: "scr.expired",
		title: "Autorização SCR vencida",
	});
	await writeAuditEvent(client, {
		actorId: identity.userId,
		action: "scr.expire",
		targetTable: "scr_authorizations",
		targetId: id,
	});
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
async function renewExpiredAuthorizations(client: PoolClient, identity: DbIdentity, limit: number): Promise<void> {
	const stale = await client.query<{
		consultation_id: string;
		expired_id: string;
		bureau_id: string;
		holder_id: string;
		client_profile_id: string | null;
		type: "PF" | "PJ";
		document: string;
		name: string | null;
		email: string | null;
		phone_e164: string | null;
	}>(
		`select c.id as consultation_id, s.id as expired_id, s.bureau_id, s.holder_id, s.client_profile_id, s.type::text as type, s.document,
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
			// Sem contato não há para onde enviar o pedido novo: a linha vencida passa a 'expired' e o próximo passo
			// "cancelar" fecha o pedido com scr_expired.
			if (!row.email) {
				await markAuthorizationExpired(client, identity, row.expired_id, row.holder_id);
				continue;
			}
			const created = await client.query<{ id: string }>(
				`insert into scr_authorizations
				   (bureau_id, document, type, name, email, phone_e164, holder_id, client_profile_id, consultation_id,
				    requested_by, channel, request_expires_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, app_user_id(), 'internal', now() + make_interval(days => $10))
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
					SCR_REQUEST_DAYS,
				],
			);
			authorizationId = created.rows[0].id;
		}
		await client.query("update consultations set scr_authorization_id = $2 where id = $1", [row.consultation_id, authorizationId]);
	}
}

export type ScrRequestToIssue = {
	scrId: string;
	// Token lido junto com o contato: a emissão só grava se a autorização ainda tem este token (ver issueSelfScrAuthorization).
	publicToken: string;
	holderId: string;
	type: "PF" | "PJ";
	document: string;
	name: string;
	email: string;
	phoneE164: string | null;
};

export async function listScrRequestsToIssue(
	client: PoolClient,
	identity: DbIdentity,
	limit: number,
): Promise<ScrRequestToIssue[]> {
	await renewExpiredAuthorizations(client, identity, limit);
	const { rows } = await client.query<{
		id: string;
		holder_id: string;
		type: "PF" | "PJ";
		document: string;
		name: string;
		email: string;
		phone_e164: string | null;
		public_token: string;
	}>(
		`select s.id, s.holder_id, s.type::text as type, s.document, s.name, s.email, s.phone_e164, s.public_token::text
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
		publicToken: r.public_token,
		holderId: r.holder_id,
		type: r.type,
		document: r.document,
		name: r.name,
		email: r.email,
		phoneE164: r.phone_e164,
	}));
}

// Só pedidos que mudam de estado no refreshOrderState: espera com todas as autorizações utilizáveis (vira ready) ou pronto
// com alguma autorização perdida (volta a esperar). Sem o filtro, os 20 mais antigos escondiam os novos.
// O tick chama refreshOrderState em cada um (passo "promover"); o refresh continua sendo a única regra.
const UNUSABLE_AUTHORIZATION = `select 1 from consultations c left join scr_authorizations s on s.id = c.scr_authorization_id
	where c.dossier_id = o.dossier_id and not coalesce(s.status = 'authorized' and s.expires_at > now(), false)`;

export async function listOrdersToPromote(client: PoolClient, limit: number): Promise<string[]> {
	const { rows } = await client.query<{ dossier_id: string }>(
		`select o.dossier_id from dossier_orders o
		  where o.bureau_id = app_bureau_id()
		    and ((o.state = 'awaiting_authorization' and not exists (${UNUSABLE_AUTHORIZATION}))
		      or (o.state = 'ready' and exists (${UNUSABLE_AUTHORIZATION})))
		  order by o.created_at limit $1`,
		[limit],
	);
	return rows.map((r) => r.dossier_id);
}

// Fora os que já têm tentativa em curso (lease ainda válida): dois ticks juntos não pagam o mesmo parecer duas vezes.
export async function listOrdersForAi(
	client: PoolClient,
	limit: number,
): Promise<{ dossierId: string; kind: OrderKind; aiAttempts: number }[]> {
	const { rows } = await client.query<{ dossier_id: string; kind: OrderKind; ai_attempts: number }>(
		`select o.dossier_id, d.kind::text as kind, o.ai_attempts
		   from dossier_orders o join dossiers d on d.id = o.dossier_id
		  where o.bureau_id = app_bureau_id() and o.state = 'completed' and o.ai_status = 'pending'
		    and (o.lease_until is null or o.lease_until < now())
		  order by o.created_at limit $1`,
		[limit],
	);
	return rows.map((r) => ({ dossierId: r.dossier_id, kind: r.kind, aiAttempts: r.ai_attempts }));
}

// Conta a tentativa e abre a lease ANTES de chamar o modelo: uma queda depois da chamada não zera o contador.
// Sem tentativa restante (queda na última), fecha como 'failed' e não devolve nada. Nulo = outro tick já pegou.
export async function claimOrderForAi(client: PoolClient, identity: DbIdentity, dossierId: string): Promise<number | null> {
	const { rows } = await client.query<{ ai_attempts: number; ai_status: AiStatus }>(
		`update dossier_orders
		    set ai_attempts = ai_attempts + case when ai_attempts < $2 then 1 else 0 end,
		        ai_status = case when ai_attempts < $2 then 'pending' else 'failed' end,
		        lease_until = case when ai_attempts < $2 then now() + make_interval(mins => $3) end,
		        updated_at = now()
		  where dossier_id = $1 and state = 'completed' and ai_status = 'pending'
		    and (lease_until is null or lease_until < now())
		returning ai_attempts, ai_status`,
		[dossierId, MAX_AI_ATTEMPTS, LEASE_MINUTES],
	);
	const row = rows[0];
	if (!row) return null;
	await writeAuditEvent(client, {
		actorId: identity.userId,
		action: "order.ai_status",
		targetTable: "dossier_orders",
		targetId: dossierId,
		metadata: { status: row.ai_status, attempts: row.ai_attempts },
	});
	return row.ai_status === "pending" ? row.ai_attempts : null;
}

export async function setAiStatus(
	client: PoolClient,
	identity: DbIdentity,
	dossierId: string,
	status: AiStatus,
	attempts: number,
): Promise<void> {
	await client.query(
		"update dossier_orders set ai_status = $2, ai_attempts = $3, lease_until = null, updated_at = now() where dossier_id = $1",
		[dossierId, status, attempts],
	);
	await writeAuditEvent(client, {
		actorId: identity.userId,
		action: "order.ai_status",
		targetTable: "dossier_orders",
		targetId: dossierId,
		metadata: { status, attempts },
	});
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
