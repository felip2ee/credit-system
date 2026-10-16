import { getRequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { exportHolder } from "@/lib/lgpd/export";
import { isUuid } from "@/lib/validators/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A auditoria `lgpd.export_holder` é gravada por exportHolder, na mesma transação da leitura.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
	let session;
	try {
		session = await getRequiredSession();
	} catch {
		return new Response("Sessão expirada.", { status: 401 });
	}
	if (!hasPermission(session, "lgpd:manage")) return new Response("Não autorizado.", { status: 403 });
	if (!isUuid(params.id)) return new Response("Titular não encontrado.", { status: 404 });

	const data = await exportHolder(session, params.id);
	if (!data) return new Response("Titular não encontrado.", { status: 404 });

	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="titular-${params.id}.json"`,
			"Cache-Control": "no-store",
		},
	});
}
