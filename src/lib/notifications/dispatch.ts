// Worker da fila (M4). Roda na role app_webhook: claim_notifications / complete_notification (020_notifications.sql).
// Nenhum destinatário, parâmetro ou mensagem de erro do provedor chega ao log: só id, canal e código.
import { getWebhookPool } from "@/lib/db/webhook-pool";

import { sendEmailNotification } from "./channels/email";
import { sendWhatsappNotification } from "./channels/whatsapp";
import type { ClaimedNotification, SendResult } from "./types";

const DEFAULT_BUDGET_MS = 45_000;
const DEFAULT_BATCH_SIZE = 10;

export interface DispatchOptions {
	budgetMs?: number;
	batchSize?: number;
}

export interface DispatchResult {
	claimed: number;
	sent: number;
	retried: number;
	failed: number;
	suppressed: number;
	// complete_notification devolveu 'stale': outra execução assumiu a linha. Não é erro.
	stale: number;
}

type Outcome = "sent" | "retry" | "failed" | "suppressed";

async function send(notification: ClaimedNotification): Promise<SendResult> {
	try {
		return notification.channel === "email"
			? await sendEmailNotification(notification)
			: await sendWhatsappNotification(notification);
	} catch {
		return { ok: false, permanent: false, code: "unexpected_error" };
	}
}

async function complete(
	notification: ClaimedNotification,
	outcome: Outcome,
	providerMessageId: string | null,
	errorCode: string | null,
): Promise<"applied" | "stale"> {
	const { rows } = await getWebhookPool().query<{
		result: "applied" | "stale";
	}>("select complete_notification($1, $2, $3, $4, $5) as result", [
		notification.id,
		notification.lease_id,
		outcome,
		providerMessageId,
		errorCode,
	]);
	return rows[0].result;
}

function logFailure(notification: ClaimedNotification, code: string): void {
	console.warn("[notifications] envio falhou", {
		id: notification.id,
		channel: notification.channel,
		code,
	});
}

async function handle(
	notification: ClaimedNotification,
): Promise<Outcome | "stale"> {
	if (notification.opted_out) {
		const applied = await complete(
			notification,
			"suppressed",
			null,
			"opted_out",
		);
		return applied === "stale" ? "stale" : "suppressed";
	}
	const result = await send(notification);
	if (result.ok) {
		const applied = await complete(
			notification,
			"sent",
			result.providerMessageId,
			null,
		);
		return applied === "stale" ? "stale" : "sent";
	}
	logFailure(notification, result.code);
	const outcome: Outcome = result.permanent ? "failed" : "retry";
	const applied = await complete(notification, outcome, null, result.code);
	return applied === "stale" ? "stale" : outcome;
}

export async function runDispatch(
	options: DispatchOptions = {},
): Promise<DispatchResult> {
	const { budgetMs = DEFAULT_BUDGET_MS, batchSize = DEFAULT_BATCH_SIZE } =
		options;
	const counts: DispatchResult = {
		claimed: 0,
		sent: 0,
		retried: 0,
		failed: 0,
		suppressed: 0,
		stale: 0,
	};
	const startedAt = Date.now();

	while (Date.now() - startedAt < budgetMs) {
		const { rows } = await getWebhookPool().query<ClaimedNotification>(
			"select * from claim_notifications($1)",
			[batchSize],
		);
		if (rows.length === 0) break;

		const settled = await Promise.allSettled(rows.map(handle));
		counts.claimed += rows.length;
		settled.forEach((entry, index) => {
			if (entry.status === "rejected") {
				// Falha ao gravar o resultado: a lease vence e o claim seguinte retoma a linha.
				const code =
					entry.reason instanceof Error && "code" in entry.reason
						? String(entry.reason.code)
						: "complete_error";
				logFailure(rows[index], code);
				return;
			}
			if (entry.value === "sent") counts.sent += 1;
			else if (entry.value === "retry") counts.retried += 1;
			else if (entry.value === "failed") counts.failed += 1;
			else if (entry.value === "suppressed") counts.suppressed += 1;
			else counts.stale += 1;
		});
		console.info("[notifications] lote", { ...counts });
	}
	return counts;
}
