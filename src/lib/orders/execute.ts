// Execução do pedido (M6): claim curto, chamadas à DEPS fora de transação e transição final curta.
// Nenhum documento, corpo da DEPS ou código chega ao log nem ao error_message.
import { executeConsultation } from "@/lib/consultations/service";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getDepsClient } from "@/lib/deps/client";
import { DepsScrPendingError } from "@/lib/deps/errors";
import { refreshDossierStatus } from "@/lib/dossiers/queries";
import { recordHolderEvent } from "@/lib/holders/queries";

import { claimOrders, completeOrder, failOrder, getExecutionPlan, retryOrderLater, type ExecutionMember } from "./queries";
import { MAX_EXECUTION_ATTEMPTS } from "./types";

export type RunOutcome = "completed" | "failed" | "retry" | "not_claimed";

type MemberResult = "completed" | "no_data" | "incompatible" | "unavailable";

const NO_DATA_MESSAGE = "Sem dados na DEPS.";
const UNAVAILABLE_MESSAGE = "Falha na consulta à DEPS.";

async function markConsultation(identity: DbIdentity, consultationId: string, status: "processing" | "error", message?: string) {
	await withUserTransaction(identity, (client) =>
		client.query("update consultations set status = $2::consultation_status, error_message = $3 where id = $1", [
			consultationId,
			status,
			message ?? null,
		]),
	);
}

// Só o nome do erro vai para o log: a mensagem pode trazer documento ou trecho da resposta.
function logFailure(step: string, error: unknown) {
	console.warn("[orders-execute] falha", { step, name: error instanceof Error ? error.name : typeof error });
}

async function consultMember(identity: DbIdentity, member: ExecutionMember, attempts: number): Promise<MemberResult> {
	await markConsultation(identity, member.consultationId, "processing");
	try {
		const deps = getDepsClient();
		const options = {
			product: member.product,
			reuseExisting: attempts > 1,
			authorization: { name: member.name ?? member.document, email: member.scrEmail ?? undefined },
			autorizacaoScr: true,
		};
		const raw = member.type === "PJ" ? await deps.consultPJ(member.document, options) : await deps.consultPF(member.document, options);
		const saved = await executeConsultation({
			identity,
			consultationId: member.consultationId,
			entityKind: member.type,
			consult: async () => raw,
		});
		if (saved.status === "payload_incompatible") return "incompatible";
		return saved.status === "completed" ? "completed" : "no_data";
	} catch (error) {
		logFailure("consult", error);
		return error instanceof DepsScrPendingError ? "no_data" : "unavailable";
	}
}

const recordExecuted = (identity: DbIdentity, member: ExecutionMember) =>
	withUserTransaction(identity, (client) =>
		recordHolderEvent(client, identity.userId, member.holderId, {
			eventType: "query.executed",
			title: "Consulta realizada",
			description: member.product,
		}),
	);

// Falha do principal: a consulta vira 'error' antes de failOrder, senão o Dossiê fica 'processing'.
function failMain(identity: DbIdentity, dossierId: string, member: ExecutionMember, result: "no_data" | "incompatible") {
	return withUserTransaction(identity, async (client) => {
		if (result === "no_data") {
			await client.query("update consultations set status = 'error', error_message = $2 where id = $1", [member.consultationId, NO_DATA_MESSAGE]);
		}
		await failOrder(client, identity, dossierId, result === "no_data" ? "deps_no_data" : "deps_incompatible");
	});
}

async function retryMain(identity: DbIdentity, dossierId: string, member: ExecutionMember, attempts: number): Promise<RunOutcome> {
	return withUserTransaction(identity, async (client) => {
		if (attempts >= MAX_EXECUTION_ATTEMPTS) {
			await client.query("update consultations set status = 'error', error_message = $2 where id = $1", [member.consultationId, UNAVAILABLE_MESSAGE]);
		}
		return (await retryOrderLater(client, identity, dossierId, attempts)) === "ready" ? "retry" : "failed";
	});
}

async function runClaimed(identity: DbIdentity, dossierId: string, attempts: number): Promise<RunOutcome> {
	const plan = await withUserTransaction(identity, (client) => getExecutionPlan(client, dossierId));
	if (!plan) throw new Error("runClaimed: order without execution plan");
	const main = plan.members.find((m) => m.isMain);
	if (!main) throw new Error("runClaimed: order without main consultation");

	for (const member of plan.members) {
		if (member.status === "completed") continue;
		const result = await consultMember(identity, member, attempts);
		if (result === "completed") {
			await recordExecuted(identity, member);
			continue;
		}
		if (member.isMain) {
			if (result === "unavailable") return retryMain(identity, dossierId, member, attempts);
			await failMain(identity, dossierId, member, result);
			return "failed";
		}
		// Sócio sem dado não derruba o pedido: a consulta fica 'error' e o Dossiê termina com erros.
		if (result === "no_data") await markConsultation(identity, member.consultationId, "error", NO_DATA_MESSAGE);
		if (result === "unavailable") await markConsultation(identity, member.consultationId, "error", UNAVAILABLE_MESSAGE);
	}

	return withUserTransaction(identity, async (client) => {
		await refreshDossierStatus(client, dossierId);
		return (await completeOrder(client, identity, dossierId)) === "completed" ? "completed" : "failed";
	});
}

async function claim(identity: DbIdentity, limit: number, dossierId?: string) {
	return withUserTransaction(identity, (client) => claimOrders(client, limit, dossierId));
}

export async function runOrderNow(identity: DbIdentity, dossierId: string): Promise<RunOutcome> {
	const [claimed] = await claim(identity, 1, dossierId);
	return claimed ? runClaimed(identity, claimed.dossierId, claimed.attempts) : "not_claimed";
}

export async function runReadyOrders(identity: DbIdentity, limit: number): Promise<{ dossierId: string; outcome: RunOutcome }[]> {
	const results: { dossierId: string; outcome: RunOutcome }[] = [];
	for (const claimed of await claim(identity, limit)) {
		results.push({ dossierId: claimed.dossierId, outcome: await runClaimed(identity, claimed.dossierId, claimed.attempts) });
	}
	return results;
}
