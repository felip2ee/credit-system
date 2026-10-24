"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { setAffiliatePct, setBureauDefaultPct } from "@/lib/affiliates/rates";
import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export interface AffiliatesBureauResult {
	error: string | null;
}

const NOT_ALLOWED = "Você não tem permissão para gerenciar afiliados.";
const SESSION_CHECK_FAILED = "Não foi possível verificar sua sessão. Tente novamente.";
const PCT_PAGE = "/afiliados";

// Número de 0 a 100 com até 2 casas, como texto (vai direto para numeric(5,2) sem perda).
const pctField = z
	.string()
	.trim()
	.regex(/^\d{1,3}(\.\d{1,2})?$/, "Informe uma porcentagem de 0 a 100, com até 2 casas.")
	.refine((v) => Number(v) <= 100, "A porcentagem vai de 0 a 100.");
const defaultPctSchema = z.object({ pct: pctField });
const affiliatePctSchema = z.object({ affiliateProfileId: z.string().uuid("Afiliado inválido."), pct: pctField.nullable() });

// Só nome e código do erro: sem valores nem dados pessoais.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[affiliates] ${step} falhou`, meta);
}

async function requireAffiliateManager(): Promise<{ session: RequiredSession } | { error: string }> {
	let session: RequiredSession;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure("requireAffiliateManager", error);
		return { error: SESSION_CHECK_FAILED };
	}
	if (!hasPermission(session, "affiliates:manage")) return { error: NOT_ALLOWED };
	return { session };
}

export async function setDefaultPctAction(values: unknown): Promise<AffiliatesBureauResult> {
	const parsed = defaultPctSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireAffiliateManager();
	if ("error" in gate) return { error: gate.error };

	try {
		await setBureauDefaultPct(gate.session, parsed.data.pct);
	} catch (error) {
		logFailure("setDefaultPctAction", error);
		return { error: "Não foi possível salvar a porcentagem." };
	}
	revalidatePath(PCT_PAGE);
	return { error: null };
}

export async function setAffiliatePctAction(values: unknown): Promise<AffiliatesBureauResult> {
	const parsed = affiliatePctSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireAffiliateManager();
	if ("error" in gate) return { error: gate.error };

	try {
		const result = await setAffiliatePct(gate.session, parsed.data.affiliateProfileId, parsed.data.pct);
		if (!result.ok) return { error: "Afiliado não encontrado." };
	} catch (error) {
		logFailure("setAffiliatePctAction", error);
		return { error: "Não foi possível salvar a porcentagem." };
	}
	revalidatePath(PCT_PAGE);
	return { error: null };
}
