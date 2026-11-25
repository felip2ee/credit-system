import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getMyOrderState } from "@/lib/orders/client-queries";
import { isUuid } from "@/lib/validators/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const text = (body: string, status: number) => new Response(body, { status, headers: NO_STORE });

// Só o estado do pedido, para a página atualizar sozinha. Outro cliente e pedido inexistente dão o mesmo 404 (RLS).
export async function GET(_request: Request, { params }: { params: { id: string } }) {
	let session;
	try {
		session = await getRequiredSession();
	} catch {
		return text("Sessão expirada.", 401);
	}
	if (session.role !== "client" || !hasPermission(session, "portal:read")) return text("Sem permissão.", 403);

	if (!isUuid(params.id)) return text("Pesquisa não encontrada.", 404);
	const state = await withUserTransaction(session, (client) => getMyOrderState(client, params.id));
	if (!state) return text("Pesquisa não encontrada.", 404);

	return Response.json({ state }, { headers: NO_STORE });
}
