import { z } from "zod";

import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getPayoutReceiptRef } from "@/lib/payouts/queries";
import { openPayoutReceipt, type ReceiptMime } from "@/lib/payouts/receipt";

// Download do comprovante. Sessão obrigatória. Qualquer negativa (papel, outro Bureau, sem comprovante,
// id inexistente ou inválido) responde o mesmo 404: a rota não revela que um repasse existe.
const notFound = () => new Response(null, { status: 404 });

const EXTENSION_BY_MIME: Record<ReceiptMime, string> = {
	"application/pdf": "pdf",
	"image/png": "png",
	"image/jpeg": "jpg",
};

// Superadmin fora de suporte, ou bureau_admin (que a RLS limita ao próprio Bureau).
function mayReadReceipts(session: RequiredSession): boolean {
	if (!hasPermission(session, "payout:read")) return false;
	if (session.role === "superadmin") return !session.supportSessionId && !session.support;
	return session.role === "bureau_admin";
}

export async function GET(_request: Request, { params }: { params: { id: string } }): Promise<Response> {
	let session: RequiredSession;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return new Response(null, { status: 401 });
		console.error("[payout-receipt] sessão falhou", { name: error instanceof Error ? error.name : typeof error });
		return new Response(null, { status: 500 });
	}
	if (!mayReadReceipts(session) || !z.string().uuid().safeParse(params.id).success) return notFound();

	try {
		const ref = await withUserTransaction(session, (client) => getPayoutReceiptRef(client, params.id));
		if (!ref) return notFound();
		if (session.role === "bureau_admin" && ref.bureauId !== session.bureauId) return notFound();

		const opened = await openPayoutReceipt(ref.objectKey);
		if (!opened) return notFound();

		return new Response(opened.body, {
			status: 200,
			headers: {
				"Content-Type": ref.mime,
				"Content-Length": String(opened.size),
				"Content-Disposition": `attachment; filename="comprovante.${EXTENSION_BY_MIME[ref.mime]}"`,
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "private, no-store",
			},
		});
	} catch (error) {
		// Só nome e código: nada de chave do objeto nem de conteúdo.
		console.error("[payout-receipt] falha ao abrir", {
			name: error instanceof Error ? error.name : typeof error,
			code: error instanceof Error && "code" in error ? error.code : undefined,
		});
		return new Response(null, { status: 500 });
	}
}
