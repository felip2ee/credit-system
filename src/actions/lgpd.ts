"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { anonymizeClientAccount, anonymizeHolder } from "@/lib/lgpd/queries";
import type { AnonymizeClientFailure, AnonymizeHolderFailure } from "@/lib/lgpd/types";
import { uuidSchema } from "@/lib/validators/id";

export interface LgpdActionResult {
	error: string | null;
}

const NOT_ALLOWED = "Você não tem permissão para anonimizar dados.";
const GENERIC_FAILURE = "Não foi possível concluir a operação.";

// Sem separadores, uma sequência de 11 (CPF) ou 14 (CNPJ) dígitos é documento.
function hasNoDocument(reason: string): boolean {
	const runs = reason.replace(/[.\-/]/g, "").match(/\d+/g) ?? [];
	return runs.every((run) => run.length !== 11 && run.length !== 14);
}

const reasonSchema = z
	.string()
	.trim()
	.min(10, "Informe o motivo com pelo menos 10 caracteres.")
	.max(500, "O motivo aceita até 500 caracteres.")
	.refine(hasNoDocument, "O motivo não pode conter CPF ou CNPJ.");
const holderSchema = z.object({ holderId: uuidSchema, reason: reasonSchema });
const clientSchema = z.object({ profileId: uuidSchema, reason: reasonSchema });

const FAILURE_MESSAGES: Record<AnonymizeHolderFailure | AnonymizeClientFailure, string> = {
	not_found: "Titular não encontrado.",
	already_anonymized: "Já anonimizado.",
	client_active: "Anonimize primeiro a conta do cliente ligada a este titular.",
	open_orders: "Há pedido em andamento para este titular. Conclua ou cancele antes de anonimizar.",
	balance: "A conta tem saldo. Devolva ou zere o saldo antes de anonimizar.",
	commission: "Você tem saldo de comissão ou saque em aberto. Saque o saldo antes de pedir a exclusão.",
};

// Só nome e código do erro: sem documento, e-mail nem motivo.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[lgpd] ${step} falhou`, meta);
}

async function lgpdManager(step: string) {
	try {
		const session = await getRequiredSession();
		return hasPermission(session, "lgpd:manage") ? { session } : { error: NOT_ALLOWED };
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure(step, error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
}

export async function anonymizeHolderAction(values: unknown): Promise<LgpdActionResult> {
	const parsed = holderSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await lgpdManager("anonymizeHolderAction");
	if (!auth.session) return { error: auth.error };

	try {
		const result = await anonymizeHolder(auth.session, parsed.data);
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] ?? GENERIC_FAILURE };
		revalidatePath("/holders/[id]", "page");
		revalidatePath("/holders");
		return { error: null };
	} catch (error) {
		logFailure("anonymizeHolderAction", error);
		return { error: "Falha ao anonimizar o titular." };
	}
}

export async function anonymizeClientAccountAction(values: unknown): Promise<LgpdActionResult> {
	const parsed = clientSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	const auth = await lgpdManager("anonymizeClientAccountAction");
	if (!auth.session) return { error: auth.error };

	try {
		const result = await anonymizeClientAccount(auth.session, parsed.data);
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] ?? GENERIC_FAILURE };
		revalidatePath("/holders/[id]", "page");
		revalidatePath("/holders");
		return { error: null };
	} catch (error) {
		logFailure("anonymizeClientAccountAction", error);
		return { error: "Falha ao anonimizar a conta do cliente." };
	}
}
