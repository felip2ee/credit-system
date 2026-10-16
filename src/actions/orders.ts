"use server";

import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";

import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { quoteOrder } from "@/lib/catalog/quote";
import { config } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { toE164 } from "@/lib/notifications/recipient";
import { ORDER_FAILED, STAFF_ORDER_MESSAGES } from "@/lib/orders/failure-messages";
import { runOrderNow, type RunOutcome } from "@/lib/orders/execute";
import { cancelOrder, placeOrder, releaseDelivery, revokeDelivery } from "@/lib/orders/queries";
import { counterOrderSchema, orderIdSchema, revokeSchema } from "@/lib/validators/order";

export interface ActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Ação não permitida.";
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para operar pedidos.";
const INVALID_PHONE = "Celular inválido. Use DDD e número.";
const ORDER_NOT_FOUND = "Pedido não encontrado.";

const RUN_MESSAGES: Record<Exclude<RunOutcome, "completed">, string> = {
	not_claimed: "O pedido não está pronto para execução.",
	retry: "Serviço da consulta indisponível. Nova tentativa automática em alguns minutos.",
	failed: "A consulta não foi concluída. A reserva foi liberada.",
};

// Só nome do passo e motivo ou código do erro: nunca documento, contato nem a mensagem do driver.
function logFailure(step: string, detail: unknown): void {
	const meta =
		detail instanceof Error
			? { name: detail.name, code: "code" in detail ? detail.code : undefined }
			: typeof detail === "string"
				? { reason: detail }
				: { name: typeof detail };
	console.error(`[orders] ${step} falhou`, meta);
}

function failureOf(step: string, reason: string): ActionResult {
	const message = STAFF_ORDER_MESSAGES[reason];
	if (!message) logFailure(step, reason);
	return { error: message ?? ORDER_FAILED };
}

// O pedido é da equipe do Bureau: o superadmin em suporte não passa pela RLS e veria "Pedido não encontrado".
async function requireStaffWriter(): Promise<{ session: RequiredSession } | { error: string }> {
	try {
		const session = await getRequiredSession();
		if (!hasPermission(session, "consultations:write")) return { error: NOT_ALLOWED };
		return session.supportSessionId ? { error: SUPPORT_ACTIVE } : { session };
	} catch {
		return { error: NOT_ALLOWED };
	}
}

export async function openCounterOrderAction(values: unknown): Promise<ActionResult> {
	const parsed = counterOrderSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };

	const auth = await requireStaffWriter();
	if ("error" in auth) return auth;

	const phoneE164 = parsed.data.contactPhone === null ? null : toE164(parsed.data.contactPhone);
	if (parsed.data.contactPhone !== null && !phoneE164) return { error: INVALID_PHONE };

	try {
		const quote = await quoteOrder(auth.session, parsed.data.productCode, { withAi: parsed.data.withAi });
		if (!quote.ok) return failureOf("openCounterOrderAction", quote.reason);
		const result = await placeOrder(
			auth.session,
			{
				productCode: parsed.data.productCode,
				withAi: parsed.data.withAi,
				self: false,
				subject: parsed.data.subject,
				partners: parsed.data.partners,
				contact: { email: parsed.data.contactEmail, phoneE164 },
				buyerProfileId: parsed.data.buyerProfileId,
			},
			quote,
		);
		if (!result.ok) return failureOf("openCounterOrderAction", result.reason);
		revalidatePath("/dossiers");
		return { error: null, id: result.dossierId };
	} catch (error) {
		logFailure("openCounterOrderAction", error);
		return { error: ORDER_FAILED };
	}
}

export async function runOrderNowAction(dossierId: unknown): Promise<ActionResult> {
	const id = orderIdSchema.safeParse(dossierId);
	if (!id.success) return { error: ORDER_NOT_FOUND };

	const auth = await requireStaffWriter();
	if ("error" in auth) return auth;

	try {
		const outcome = await runOrderNow(auth.session, id.data);
		if (outcome === "not_claimed") return { error: RUN_MESSAGES.not_claimed };
		revalidatePath(`/dossiers/${id.data}`);
		return outcome === "completed" ? { error: null, id: id.data } : { error: RUN_MESSAGES[outcome] };
	} catch (error) {
		logFailure("runOrderNowAction", error);
		return { error: ORDER_FAILED };
	}
}

type Transition = (client: PoolClient, session: RequiredSession) => Promise<{ ok: true } | { ok: false; reason: string }>;

async function transitionOrder(step: string, dossierId: string, work: Transition): Promise<ActionResult> {
	const auth = await requireStaffWriter();
	if ("error" in auth) return auth;

	try {
		const result = await withUserTransaction(auth.session, (client) => work(client, auth.session));
		if (!result.ok) return failureOf(step, result.reason);
		revalidatePath(`/dossiers/${dossierId}`);
		return { error: null, id: dossierId };
	} catch (error) {
		logFailure(step, error);
		return { error: ORDER_FAILED };
	}
}

export async function cancelOrderAction(dossierId: unknown): Promise<ActionResult> {
	const id = orderIdSchema.safeParse(dossierId);
	if (!id.success) return { error: ORDER_NOT_FOUND };
	return transitionOrder("cancelOrderAction", id.data, (client, session) =>
		cancelOrder(client, session, id.data, "cancelled_by_staff"),
	);
}

export async function releaseOrderAction(dossierId: unknown): Promise<ActionResult> {
	const id = orderIdSchema.safeParse(dossierId);
	if (!id.success) return { error: ORDER_NOT_FOUND };
	return transitionOrder("releaseOrderAction", id.data, (client, session) =>
		releaseDelivery(client, session, id.data, config.betterAuthUrl),
	);
}

export async function revokeOrderAction(values: unknown): Promise<ActionResult> {
	const parsed = revokeSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? NOT_ALLOWED };
	return transitionOrder("revokeOrderAction", parsed.data.dossierId, (client, session) =>
		revokeDelivery(client, session, parsed.data.dossierId, parsed.data.reason),
	);
}
