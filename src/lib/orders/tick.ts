// Tick dos pedidos (M6). Roda por Bureau com o perfil de sistema, em passos independentes e idempotentes:
// cada passo na sua transação; o erro de um passo conta em `errors` e não para os seguintes nem os outros Bureaus.
// A DEPS e a IA nunca rodam dentro de uma transação aberta.
import { config } from "@/lib/config";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { listSweepTargets, purgeBureauData, purgeTechnicalData } from "@/lib/lgpd/queries";
import { readScrTermSettings } from "@/lib/settings/readers";

import { generateOrderAi } from "./ai";
import { runReadyOrders } from "./execute";
import { issueRequest } from "./issue-request";
import { refreshOrderState, releaseDelivery } from "./queries";
import {
	cancelStalledOrders,
	claimOrderForAi,
	expireScrRequests,
	listOnlineOrdersToRelease,
	listOrdersForAi,
	listOrdersToPromote,
	listScrRequestsToIssue,
	setAiStatus,
} from "./tick-queries";
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
	// Comissões de afiliado que saíram da carência neste tick.
	commissionsReleased: number;
	// Bureaus que outro tick já processava (lock por Bureau): ficam para o próximo.
	skipped: number;
	errors: number;
	// Linhas apagadas ou anonimizadas pela varredura LGPD, somadas por tabela (todos os Bureaus).
	purged: Record<string, number>;
};

// Pedidos executados no tick inteiro (todos os Bureaus): cada um chama a DEPS, e o tick tem de caber no timeout do cron.
export const TICK_EXECUTION_LIMIT = 5;
// Itens por passo e por Bureau; o que sobra fica para o próximo tick.
const STEP_BATCH = 20;
// A lista de promoção já traz só pedidos que mudam de estado e o passo é SQL barato: o lote é folgado.
const PROMOTE_BATCH = 500;

type Counters = Omit<TickResult, "bureaus">;

// A varredura técnica não tem tenant e a função SECURITY DEFINER não lê o contexto: roda mesmo sem Bureau devido.
const PLATFORM_IDENTITY: DbIdentity = { userId: "", role: "operator", bureauId: null };


function addCounts(total: Record<string, number>, counts: Record<string, number> | undefined): void {
	for (const [table, n] of Object.entries(counts ?? {})) total[table] = (total[table] ?? 0) + n;
}

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

	const toIssue = (await guarded(counters, "list-requests", () => withUserTransaction(identity, (client) => listScrRequestsToIssue(client, identity, STEP_BATCH)))) ?? [];
	const term = toIssue.length ? await guarded(counters, "term", () => readScrTermSettings(identity)) : undefined;
	if (term) {
		for (const request of toIssue) {
			const issued = await guarded(counters, "request", () => issueRequest(identity, request, term, siteUrl));
			if (issued?.ok) counters.requested += 1;
			// superseded: o contato mudou depois da leitura; o próximo tick emite para o contato novo.
			else if (issued && issued.reason !== "superseded") {
				counters.errors += 1;
				console.error("[orders-tick] passo falhou", { step: "request", reason: issued.reason });
			}
		}
	}

	const toPromote = (await guarded(counters, "list-promote", () => withUserTransaction(identity, (client) => listOrdersToPromote(client, PROMOTE_BATCH)))) ?? [];
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
			// A tentativa é contada antes da chamada ao modelo (claim com lease): queda ou tick concorrente não paga duas vezes.
			const attempts = await withUserTransaction(identity, (client) => claimOrderForAi(client, identity, order.dossierId));
			if (attempts === null) return;
			const outcome = await generateOrderAi(identity, order.dossierId, order.kind);
			const status = outcome === "done" ? "done" : attempts >= MAX_AI_ATTEMPTS ? "failed" : "pending";
			await withUserTransaction(identity, (client) => setAiStatus(client, identity, order.dossierId, status, attempts));
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

// Um tick por Bureau de cada vez: lock de sessão numa conexão própria (a DEPS e a IA rodam fora de transação, então um
// lock de transação não cobriria o trabalho). Liberado no finally; se o unlock falhar, a conexão é descartada e o lock cai.
async function withBureauLock(bureauId: string, work: () => Promise<void>): Promise<boolean> {
	const lockClient = await pool.connect();
	const lockArgs = [bureauId];
	let discard = false;
	let locked = false;
	try {
		const { rows } = await lockClient.query<{ locked: boolean }>(
			"select pg_try_advisory_lock(hashtext('orders_tick'), hashtext($1::text)) as locked",
			lockArgs,
		);
		locked = rows[0].locked;
		if (!locked) return false;
		await work();
		return true;
	} catch (error) {
		discard = true;
		throw error;
	} finally {
		if (locked && !discard) {
			await lockClient
				.query("select pg_advisory_unlock(hashtext('orders_tick'), hashtext($1::text))", lockArgs)
				.catch(() => {
					discard = true;
				});
		}
		lockClient.release(discard);
	}
}

// A retenção de 5 anos fica desligada até o jurídico confirmar os prazos (LGPD_PURGE_ENABLED=1 liga).
// lgpd_sweep_targets() só devolve Bureau sem varredura nas últimas 24 h: o guarda vive no banco e vale após reinício.
async function sweepBureaus(result: TickResult): Promise<void> {
	if (process.env.LGPD_PURGE_ENABLED !== "1") return;
	const targets = (await guarded(result, "list-purge-bureaus", () => listSweepTargets(PLATFORM_IDENTITY))) ?? [];
	for (const target of targets) {
		const identity: DbIdentity = { userId: target.systemProfileId, role: "operator", bureauId: target.bureauId };
		addCounts(result.purged, await guarded(result, "purge-bureau", () => purgeBureauData(identity)));
	}
}

// A função SECURITY DEFINER só age sem usuário nem Bureau no contexto (identidade da plataforma).
async function releaseDueCommissions(identity: DbIdentity): Promise<number> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ released: number }>("select release_due_commissions() as released");
		return rows[0].released;
	});
}

export async function runOrdersTick(): Promise<TickResult> {
	const due = await pool.query<{ bureau_id: string; system_profile_id: string }>(
		"select bureau_id, system_profile_id from due_order_bureaus()",
	);
	const result: TickResult = {
		bureaus: due.rows.length,
		expired: 0,
		cancelled: 0,
		requested: 0,
		promoted: 0,
		executed: 0,
		ai: 0,
		released: 0,
		commissionsReleased: 0,
		skipped: 0,
		errors: 0,
		purged: {},
	};
	addCounts(result.purged, await guarded(result, "purge-technical", () => purgeTechnicalData(PLATFORM_IDENTITY)));
	result.commissionsReleased =
		(await guarded(result, "release-commissions", () => releaseDueCommissions(PLATFORM_IDENTITY))) ?? 0;
	for (const bureau of due.rows) {
		const identity: DbIdentity = { userId: bureau.system_profile_id, role: "operator", bureauId: bureau.bureau_id };
		const ran = await withBureauLock(bureau.bureau_id, () =>
			runBureau(identity, result, () => Math.max(TICK_EXECUTION_LIMIT - result.executed, 0)),
		);
		if (!ran) result.skipped += 1;
	}
	await sweepBureaus(result);
	return result;
}
