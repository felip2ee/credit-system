// Worker da fila (M4). Roda na role app_dispatch: claim_notifications / complete_notification (020_notifications.sql).
// Nenhum destinatário, parâmetro ou mensagem de erro do provedor chega ao log: só id, canal e código.
import { getDispatchPool } from "@/lib/db/dispatch-pool";

import { sendEmailNotification } from "./channels/email";
import { sendPushNotification } from "./channels/push";
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
	// Resultado não gravado nem na segunda tentativa: a lease vence e a linha pode ser reenviada.
	errors: number;
}

type Outcome = "sent" | "retry" | "failed" | "suppressed";

async function send(notification: ClaimedNotification): Promise<SendResult> {
	try {
		switch (notification.channel) {
			case "email":
				return await sendEmailNotification(notification);
			case "whatsapp":
				return await sendWhatsappNotification(notification);
			case "push":
				return await sendPushNotification(notification);
		}
	} catch (error) {
		// Só o nome da classe: a mensagem pode trazer destinatário, parâmetro ou token.
		console.warn("[notifications] erro inesperado no envio", {
			id: notification.id,
			channel: notification.channel,
			name: error instanceof Error ? error.name : typeof error,
		});
		return { ok: false, permanent: false, code: "unexpected_error" };
	}
}

async function completeOnce(
	notification: ClaimedNotification,
	outcome: Outcome,
	providerMessageId: string | null,
	errorCode: string | null,
): Promise<"applied" | "stale"> {
	const { rows } = await getDispatchPool().query<{
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

// Uma nova tentativa com a mesma lease: se a gravação do envio falhar, a lease vence e a linha é reenviada.
// Se a primeira tentativa chegou a gravar e só a resposta se perdeu, a segunda devolve 'stale'.
async function complete(
	notification: ClaimedNotification,
	outcome: Outcome,
	providerMessageId: string | null,
	errorCode: string | null,
): Promise<"applied" | "stale"> {
	try {
		return await completeOnce(notification, outcome, providerMessageId, errorCode);
	} catch {
		return completeOnce(notification, outcome, providerMessageId, errorCode);
	}
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
		errors: 0,
	};
	const startedAt = Date.now();

	while (Date.now() - startedAt < budgetMs) {
		const { rows } = await getDispatchPool().query<ClaimedNotification>(
			"select * from claim_notifications($1)",
			[batchSize],
		);
		if (rows.length === 0) break;

		const settled = await Promise.allSettled(rows.map(handle));
		counts.claimed += rows.length;
		settled.forEach((entry, index) => {
			if (entry.status === "rejected") {
				// Resultado não gravado: a lease vence e o claim seguinte retoma a linha (pode reenviar).
				const code =
					entry.reason instanceof Error && "code" in entry.reason
						? String(entry.reason.code)
						: "complete_error";
				console.warn("[notifications] resultado não gravado", {
					id: rows[index].id,
					channel: rows[index].channel,
					code,
				});
				counts.errors += 1;
				return;
			}
			if (entry.value === "sent") counts.sent += 1;
			else if (entry.value === "retry") counts.retried += 1;
			else if (entry.value === "failed") counts.failed += 1;
			else if (entry.value === "suppressed") counts.suppressed += 1;
			else counts.stale += 1;
		});
		console.warn("[notifications] lote", { ...counts });
	}
	return counts;
}
