// Tick dos pedidos (M6). Roda por Bureau com o perfil de sistema, em passos independentes e idempotentes:
// cada passo na sua transação; o erro de um passo conta em `errors` e não para os seguintes nem os outros Bureaus.
// A DEPS e a IA nunca rodam dentro de uma transação aberta.
import { randomInt } from "node:crypto";

import { config } from "@/lib/config";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { recordHolderEvent } from "@/lib/holders/queries";
import { buildScrConsentTerm } from "@/lib/scr/consent-term";
import { issueSelfScrAuthorization, type IssueSelfScrResult } from "@/lib/scr/queries";
import { readScrTermSettings, type ScrTermSettings } from "@/lib/settings/readers";
import { formatCNPJ, formatCPF, formatDate } from "@/lib/utils";

import { generateOrderAi } from "./ai";
import { runReadyOrders } from "./execute";
import {
	cancelStalledOrders,
	expireScrRequests,
	listOnlineOrdersToRelease,
	listOrdersForAi,
	listOrdersToPromote,
	listScrRequestsToIssue,
	refreshOrderState,
	releaseDelivery,
	setAiStatus,
	type ScrRequestToIssue,
} from "./queries";
import { MAX_AI_ATTEMPTS, type OrderState } from "./types";

export type TickResult = {
	bureaus: number;
	expired: number;
	cancelled: number;
	requested: number;
	promoted: number;
	executed: number;
	ai: number;
	released: number;
	errors: number;
};

// Pedidos executados no tick inteiro (todos os Bureaus): cada um chama a DEPS, e o tick tem de caber no timeout do cron.
export const TICK_EXECUTION_LIMIT = 5;
// Itens por passo e por Bureau; o que sobra fica para o próximo tick.
const STEP_BATCH = 20;

// Mesmo alfabeto de actions/scr-self.ts (arquivo "use server": não exporta função síncrona).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
function generateCode(): string {
	let code = "";
	for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
	return code;
}

type Counters = Omit<TickResult, "bureaus">;

// Roda uma unidade de trabalho. O log leva só o nome do passo e do erro: a mensagem pode trazer documento ou contato.
async function guarded<T>(counters: Counters, step: string, work: () => Promise<T>): Promise<T | undefined> {
	try {
		return await work();
	} catch (error) {
		counters.errors += 1;
		console.error("[orders-tick] passo falhou", {
			step,
			name: error instanceof Error ? error.name : typeof error,
			code: error instanceof Error && "code" in error ? error.code : undefined,
		});
		return undefined;
	}
}

async function issueRequest(
	identity: DbIdentity,
	request: ScrRequestToIssue,
	term: ScrTermSettings,
	siteUrl: string,
): Promise<IssueSelfScrResult> {
	const document = request.type === "PJ" ? formatCNPJ(request.document) : formatCPF(request.document);
	const consent = buildScrConsentTerm({
		authorizedName: term.authorizedName,
		authorizedDocument: term.authorizedDocument || undefined,
		institutionName: term.institutionName,
		clientName: request.name,
		document,
		city: term.city,
		date: formatDate(new Date()),
	});
	const issued = await issueSelfScrAuthorization(identity, request.scrId, {
		code: generateCode(),
		email: request.email,
		consentText: consent.fullText,
		consentName: request.name,
		consentDocument: document,
		notification: {
			recipient: request.email,
			clientName: request.name,
			authorizedName: term.authorizedName,
			siteUrl,
			phone: request.phoneE164,
		},
	});
	if (issued.ok) {
		await withUserTransaction(identity, (client) =>
			recordHolderEvent(client, identity.userId, request.holderId, {
				eventType: "scr.requested",
				title: "Pedido de autorização SCR enviado",
			}),
		);
	}
	return issued;
}

async function promoteOrder(identity: DbIdentity, dossierId: string): Promise<boolean> {
	return withUserTransaction(identity, async (client) => {
		const before = await client.query<{ state: OrderState }>("select state from dossier_orders where dossier_id = $1", [dossierId]);
		const after = await refreshOrderState(client, dossierId);
		return before.rows[0]?.state === "awaiting_authorization" && after === "ready";
	});
}

async function runBureau(identity: DbIdentity, counters: Counters, executionLeft: () => number): Promise<void> {
	const siteUrl = config.betterAuthUrl.replace(/\/$/, "");

	counters.expired +=
		(await guarded(counters, "expire", () => withUserTransaction(identity, (client) => expireScrRequests(client, identity)))) ?? 0;
	counters.cancelled +=
		(await guarded(counters, "cancel", () => withUserTransaction(identity, (client) => cancelStalledOrders(client, identity)))) ?? 0;

	const toIssue = (await guarded(counters, "list-requests", () => withUserTransaction(identity, (client) => listScrRequestsToIssue(client, STEP_BATCH)))) ?? [];
	const term = toIssue.length ? await guarded(counters, "term", () => readScrTermSettings(identity)) : undefined;
	if (term) {
		for (const request of toIssue) {
			const issued = await guarded(counters, "request", () => issueRequest(identity, request, term, siteUrl));
			if (issued?.ok) counters.requested += 1;
			else if (issued) {
				counters.errors += 1;
				console.error("[orders-tick] passo falhou", { step: "request", reason: issued.reason });
			}
		}
	}

	const toPromote = (await guarded(counters, "list-promote", () => withUserTransaction(identity, (client) => listOrdersToPromote(client, STEP_BATCH)))) ?? [];
	for (const dossierId of toPromote) {
		if (await guarded(counters, "promote", () => promoteOrder(identity, dossierId))) counters.promoted += 1;
	}

	const limit = executionLeft();
	if (limit > 0) {
		const ran = await guarded(counters, "execute", () => runReadyOrders(identity, limit));
		counters.executed += ran?.length ?? 0;
	}

	const toAnalyse = (await guarded(counters, "list-ai", () => withUserTransaction(identity, (client) => listOrdersForAi(client, STEP_BATCH)))) ?? [];
	for (const order of toAnalyse) {
		await guarded(counters, "ai", async () => {
			const outcome = await generateOrderAi(identity, order.dossierId, order.kind);
			const attempts = order.aiAttempts + 1;
			const status = outcome === "done" ? "done" : attempts >= MAX_AI_ATTEMPTS ? "failed" : "pending";
			await withUserTransaction(identity, (client) => setAiStatus(client, order.dossierId, status, attempts));
			counters.ai += 1;
		});
	}

	const toRelease = (await guarded(counters, "list-release", () => withUserTransaction(identity, (client) => listOnlineOrdersToRelease(client, STEP_BATCH)))) ?? [];
	for (const dossierId of toRelease) {
		const released = await guarded(counters, "release", () =>
			withUserTransaction(identity, (client) => releaseDelivery(client, identity, dossierId, config.betterAuthUrl)),
		);
		if (released?.ok) counters.released += 1;
		else if (released) console.warn("[orders-tick] liberação não feita", { reason: released.reason });
	}
}

export async function runOrdersTick(): Promise<TickResult> {
	const due = await pool.query<{ bureau_id: string; system_profile_id: string }>(
		"select bureau_id, system_profile_id from due_order_bureaus()",
	);
	const result: TickResult = { bureaus: due.rows.length, expired: 0, cancelled: 0, requested: 0, promoted: 0, executed: 0, ai: 0, released: 0, errors: 0 };
	for (const bureau of due.rows) {
		const identity: DbIdentity = { userId: bureau.system_profile_id, role: "operator", bureauId: bureau.bureau_id };
		await runBureau(identity, result, () => Math.max(TICK_EXECUTION_LIMIT - result.executed, 0));
	}
	return result;
}
