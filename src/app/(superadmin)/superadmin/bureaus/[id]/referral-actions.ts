"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { clearBureauReferrer, setBureauReferrer, type SetBureauReferrerResult } from "@/lib/bureaus/referrals";
import { hasPermission } from "@/lib/db/permissions";
import { bureauReferrerSchema, clearBureauReferrerSchema } from "@/lib/validators/bureau-referral";

export interface BureauReferralResult {
	error: string | null;
}

const NOT_ALLOWED = "Você não tem permissão para alterar o bureau indicador.";
const SUPPORT_BLOCKED = "Encerre a sessão de suporte para alterar o bureau indicador.";

const REASON_MESSAGE: Record<Extract<SetBureauReferrerResult, { ok: false }>["reason"], string> = {
	self: "Um bureau não pode indicar a si mesmo.",
	cycle: "Essa indicação cria um ciclo entre bureaus.",
	already_referred: "Esse bureau já tem um indicador. Remova o atual antes de trocar.",
	not_found: "Bureau não encontrado.",
	split_over_100: "A soma das porcentagens (sócios, bureau, indicador e afiliados) passa de 100%. Reduza uma delas.",
};

function logFailure(action: string, error: unknown): void {
	const meta = error instanceof Error ? { name: error.name, code: "code" in error ? error.code : undefined } : { name: typeof error };
	console.error(`[bureau-referral] ${action} falhou`, meta);
}

// Sessão e permissão ficam na action, não só na UI. Suporte não grava (o RLS também barra).
type Auth = { session: Awaited<ReturnType<typeof getRequiredSession>>; error?: undefined } | { session?: undefined; error: string };

async function authorize(): Promise<Auth> {
	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure("sessão", error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (!hasPermission(session, "bureau_referral:manage")) return { error: NOT_ALLOWED };
	if (session.supportSessionId) return { error: SUPPORT_BLOCKED };
	return { session };
}

export async function setBureauReferrerAction(values: unknown): Promise<BureauReferralResult> {
	const parsed = bureauReferrerSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const auth = await authorize();
	if (!auth.session) return { error: auth.error };
	try {
		const result = await setBureauReferrer(auth.session, parsed.data);
		if (!result.ok) return { error: REASON_MESSAGE[result.reason] };
		revalidatePath(`/superadmin/bureaus/${parsed.data.referredBureauId}`);
		return { error: null };
	} catch (error) {
		logFailure("setBureauReferrerAction", error);
		return { error: "Não foi possível salvar o bureau indicador." };
	}
}

export async function clearBureauReferrerAction(values: unknown): Promise<BureauReferralResult> {
	const parsed = clearBureauReferrerSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const auth = await authorize();
	if (!auth.session) return { error: auth.error };
	try {
		await clearBureauReferrer(auth.session, parsed.data);
		revalidatePath(`/superadmin/bureaus/${parsed.data.referredBureauId}`);
		return { error: null };
	} catch (error) {
		logFailure("clearBureauReferrerAction", error);
		return { error: "Não foi possível remover o bureau indicador." };
	}
}
