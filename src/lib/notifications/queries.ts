// Fila de notificações (M4). Toda escrita passa por função SQL (020_notifications.sql); a aplicação não lê
// recipient, params nem idempotency_key. enqueueNotification usa a transação do chamador: ele decide o commit.
import type { PoolClient } from "pg";

import { SENSITIVE_KEY, writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

import { maskRecipient, normalizeEmail, toE164 } from "./recipient";
import { validateWhatsappParams } from "./render";
import type { NotificationChannel, NotificationStatus } from "./types";

export type EnqueueInput = {
	templateKey: string;
	channel: NotificationChannel;
	recipient: string;
	params: Record<string, string>;
	idempotencyKey: string;
	reference?: string;
};

export type EnqueueFailure =
	| "invalid_recipient"
	| "invalid_params"
	| "template_not_found"
	| "not_allowed";
export type EnqueueResult =
	| { ok: true; id: string; duplicate: boolean }
	| { ok: false; reason: EnqueueFailure };

const ENQUEUE_FAILURES: readonly string[] = [
	"invalid_recipient",
	"invalid_params",
	"template_not_found",
	"not_allowed",
];

// NoDocumentInPayload: CPF, CNPJ, token e afins nunca viajam num template.
const hasSensitiveParam = (params: Record<string, string>): boolean =>
	Object.keys(params).some((key) => SENSITIVE_KEY.test(key));

export async function enqueueNotification(
	client: PoolClient,
	identity: DbIdentity,
	input: EnqueueInput,
): Promise<EnqueueResult> {
	const recipient =
		input.channel === "email"
			? normalizeEmail(input.recipient)
			: toE164(input.recipient);
	if (recipient === null) return { ok: false, reason: "invalid_recipient" };
	if (hasSensitiveParam(input.params))
		return { ok: false, reason: "invalid_params" };
	if (
		input.channel === "whatsapp" &&
		!validateWhatsappParams(input.params).ok
	) {
		return { ok: false, reason: "invalid_params" };
	}

	const { rows } = await client.query<{
		ok: boolean;
		reason: string | null;
		notification_id: string | null;
		duplicate: boolean;
	}>(
		"select ok, reason, notification_id, duplicate from enqueue_notification($1, $2, $3, $4, $5::jsonb, $6, $7)",
		[
			input.templateKey,
			input.channel,
			recipient,
			maskRecipient(input.channel, recipient),
			JSON.stringify(input.params),
			input.idempotencyKey,
			input.reference ?? null,
		],
	);
	const row = rows[0];
	if (!row.ok || row.notification_id === null) {
		// invalid_input (chave de idempotência ou referência fora do limite) cai em invalid_params.
		const reason = ENQUEUE_FAILURES.includes(row.reason ?? "")
			? (row.reason as EnqueueFailure)
			: "invalid_params";
		return { ok: false, reason };
	}
	if (!row.duplicate) {
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "notification.enqueue",
			targetTable: "notifications",
			targetId: row.notification_id,
			metadata: { templateKey: input.templateKey, channel: input.channel },
		});
	}
	return { ok: true, id: row.notification_id, duplicate: row.duplicate };
}

export type NotificationRow = {
	id: string;
	bureauId: string | null;
	templateId: string;
	// Nulo para quem não lê notification_templates (só o superadmin fora de suporte lê).
	templateKey: string | null;
	channel: NotificationChannel;
	recipientMasked: string;
	reference: string | null;
	status: NotificationStatus;
	attempts: number;
	maxAttempts: number;
	nextAttemptAt: Date;
	lastErrorCode: string | null;
	createdBy: string;
	createdAt: Date;
	sentAt: Date | null;
	updatedAt: Date;
};

export type ListNotificationsInput = {
	status?: NotificationStatus;
	channel?: NotificationChannel;
	limit: number;
	// Valor de nextCursor da página anterior.
	cursor?: string | null;
};

export type NotificationPage = {
	rows: NotificationRow[];
	nextCursor: string | null;
};

const MAX_PAGE_SIZE = 100;
// created_at em UTC com microssegundos: o Date do JS perderia a precisão e repetiria linhas entre páginas.
const CURSOR_PATTERN =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f-]{36})$/;

export async function listNotifications(
	identity: DbIdentity,
	input: ListNotificationsInput,
): Promise<NotificationPage> {
	const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_PAGE_SIZE);
	const cursor = input.cursor ? CURSOR_PATTERN.exec(input.cursor) : null;
	if (input.cursor && !cursor) throw new Error("Invalid notification cursor");

	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{
			id: string;
			bureau_id: string | null;
			template_id: string;
			template_key: string | null;
			channel: NotificationChannel;
			recipient_masked: string;
			reference: string | null;
			status: NotificationStatus;
			attempts: number;
			max_attempts: number;
			next_attempt_at: Date;
			last_error_code: string | null;
			created_by: string;
			created_at: Date;
			sent_at: Date | null;
			updated_at: Date;
			created_at_utc: string;
		}>(
			`select n.id, n.bureau_id, n.template_id, t.key as template_key, n.channel, n.recipient_masked, n.reference,
			        n.status, n.attempts, n.max_attempts, n.next_attempt_at, n.last_error_code, n.created_by,
			        n.created_at, n.sent_at, n.updated_at,
			        to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_utc
			   from notifications n
			   left join notification_templates t on t.id = n.template_id
			  where ($1::text is null or n.status = $1)
			    and ($2::text is null or n.channel = $2)
			    and ($3::timestamptz is null or (n.created_at, n.id) < ($3::timestamptz, $4::uuid))
			  order by n.created_at desc, n.id desc
			  limit $5`,
			[
				input.status ?? null,
				input.channel ?? null,
				cursor?.[1] ?? null,
				cursor?.[2] ?? null,
				limit + 1,
			],
		);
		const page = rows.slice(0, limit);
		const last = page[page.length - 1];
		return {
			rows: page.map((r) => ({
				id: r.id,
				bureauId: r.bureau_id,
				templateId: r.template_id,
				templateKey: r.template_key,
				channel: r.channel,
				recipientMasked: r.recipient_masked,
				reference: r.reference,
				status: r.status,
				attempts: r.attempts,
				maxAttempts: r.max_attempts,
				nextAttemptAt: r.next_attempt_at,
				lastErrorCode: r.last_error_code,
				createdBy: r.created_by,
				createdAt: r.created_at,
				sentAt: r.sent_at,
				updatedAt: r.updated_at,
			})),
			nextCursor:
				rows.length > limit ? `${last.created_at_utc}_${last.id}` : null,
		};
	});
}

export type TemplateRow = {
	key: string;
	channel: NotificationChannel;
	version: number;
	status: "active" | "retired";
	waTemplateName: string | null;
	waLanguage: string | null;
	params: string[];
};

// Só o superadmin fora de suporte lê os templates (RLS). Sem corpo de e-mail.
export async function listTemplates(
	identity: DbIdentity,
): Promise<TemplateRow[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{
			key: string;
			channel: NotificationChannel;
			version: number;
			status: "active" | "retired";
			wa_template_name: string | null;
			wa_language: string | null;
			params: string[];
		}>(
			`select key, channel, version, status, wa_template_name, wa_language, params
			   from notification_templates
			  order by key, channel, version desc`,
		);
		return rows.map((r) => ({
			key: r.key,
			channel: r.channel,
			version: r.version,
			status: r.status,
			waTemplateName: r.wa_template_name,
			waLanguage: r.wa_language,
			params: r.params,
		}));
	});
}

export type RetryFailure =
	| "not_allowed"
	| "not_found"
	| "invalid_state"
	| "payload_purged";
export type RetryResult = { ok: true } | { ok: false; reason: RetryFailure };

// Nova tentativa manual: failed -> pending e a auditoria, na mesma transação.
export async function retryNotification(
	identity: DbIdentity,
	id: string,
): Promise<RetryResult> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{
			ok: boolean;
			reason: RetryFailure | null;
		}>("select ok, reason from retry_notification($1)", [id]);
		if (!rows[0].ok)
			return { ok: false, reason: rows[0].reason ?? "invalid_state" };
		// retry_notification só aceita o superadmin fora de suporte, que lê todas as linhas. A política de audit_logs
		// só aceita bureau_id nulo para ele (fora das ações listadas na 017): o Bureau alvo vai na metadata.
		const target = await client.query<{ bureau_id: string | null }>("select bureau_id from notifications where id = $1", [id]);
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "notification.retry",
			targetTable: "notifications",
			targetId: id,
			metadata: { bureauId: target.rows[0]?.bureau_id ?? null },
		});
		return { ok: true };
	});
}
