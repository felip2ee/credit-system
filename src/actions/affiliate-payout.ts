"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isAffiliateEnabled } from "@/lib/affiliates/enabled";
import { setPayoutMethod } from "@/lib/affiliates/payout-settings";
import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { setPayoutMethodSchema } from "@/lib/validators/affiliate-payout";

export interface AffiliatePayoutResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para alterar este pagamento.";
const AFFILIATE_DISABLED = "A afiliação não está disponível neste momento.";

// Sem profileId, o afiliado muda o próprio modo. Com profileId, o dono do bureau (ou o superadmin) muda em nome dele.
const profileIdSchema = z.string().uuid("Afiliado inválido.").optional();

export async function setPayoutMethodAction(values: unknown): Promise<AffiliatePayoutResult> {
	const rawProfileId = typeof values === "object" && values !== null ? (values as { profileId?: unknown }).profileId : undefined;
	const profile = profileIdSchema.safeParse(rawProfileId ?? undefined);
	if (!profile.success) return { error: profile.error.issues[0]?.message ?? "Dados inválidos." };
	const checked = setPayoutMethodSchema.safeParse(values);
	if (!checked.success) return { error: checked.error.issues[0]?.message ?? "Dados inválidos." };

	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		console.error("[affiliates] setPayoutMethodAction: sessão falhou", { name: error instanceof Error ? error.name : typeof error });
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (!hasPermission(session, "affiliate_payout:manage")) return { error: NOT_ALLOWED };

	const profileId = profile.data ?? session.userId;
	try {
		// Seção desligada pelo Bureau: recusa também o dono em nome do afiliado. O superadmin (sem Bureau) escolhe o alvo.
		if (session.role !== "superadmin" && !(await isAffiliateEnabled(session))) return { error: AFFILIATE_DISABLED };
		const result = await setPayoutMethod(session, {
			owner: { profileId },
			method: checked.data.method,
			asaasWalletId: checked.data.asaasWalletId,
		});
		if (result.error) return { error: result.error };
	} catch (error) {
		// Só nome e código: sem walletId nem corpo da requisição.
		console.error("[affiliates] setPayoutMethodAction falhou", {
			name: error instanceof Error ? error.name : typeof error,
			code: error instanceof Error && "code" in error ? error.code : undefined,
		});
		return { error: "Não foi possível salvar. Tente novamente." };
	}
	revalidatePath("/portal/afiliacao");
	revalidatePath("/portal/afiliacao/pagamentos");
	revalidatePath("/afiliados");
	return { error: null, id: profileId };
}
