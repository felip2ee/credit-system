"use server";

import { z } from "zod";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listPayableEntries, type PayablePage } from "@/lib/payables/queries";

// Cursor "<timestamp UTC com microssegundos>_<uuid>"; a query valida o formato de novo.
const schema = z.object({
	bureauId: z.string().uuid(),
	cursor: z.string().min(1).max(100),
});

const NOT_ALLOWED = "Você não tem permissão para ver os lançamentos.";

// Só nome e código do erro: sem valores nem dados pessoais.
function logFailure(error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error("[payables] loadMorePayablesAction falhou", meta);
}

export type PayablesPageResult = { error: string | null; page?: PayablePage };

// Próxima página do extrato a repassar. A RLS limita o Bureau visível a cada papel.
export async function loadMorePayablesAction(
	values: unknown,
): Promise<PayablesPageResult> {
	const parsed = schema.safeParse(values);
	if (!parsed.success) return { error: "Dados inválidos." };
	try {
		const session = await getRequiredSession();
		if (!hasPermission(session, "payout:read")) return { error: NOT_ALLOWED };
		// Só o superadmin escolhe o Bureau; os demais papéis leem o próprio, ignorando o id enviado.
		const bureauId =
			session.role === "superadmin" ? parsed.data.bureauId : session.bureauId;
		if (!bureauId) return { error: NOT_ALLOWED };
		const page = await withUserTransaction(session, (client) =>
			listPayableEntries(client, bureauId, { cursor: parsed.data.cursor }),
		);
		return { error: null, page };
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		if (error instanceof RangeError) return { error: "Dados inválidos." };
		logFailure(error);
		return { error: "Não foi possível carregar os lançamentos." };
	}
}
