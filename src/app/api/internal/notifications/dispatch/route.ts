import { createHash, timingSafeEqual } from "node:crypto";

import { readNotificationsDispatchSecret } from "@/lib/config";
import { dispatchDatabaseConfigured } from "@/lib/db/database-config-check";
import { runDispatch } from "@/lib/notifications/dispatch";

// Rota pública para o middleware (sem sessão): a autenticação é o segredo do header, chamado pelo cron.
export const dynamic = "force-dynamic";

// Hash dos dois lados iguala o tamanho; timingSafeEqual não vaza o prefixo comum.
function authorizationMatches(received: string | null, secret: string): boolean {
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(received ?? ""), digest(`Bearer ${secret}`));
}

const respond = (status: number) => new Response(null, { status });

export async function POST(request: Request): Promise<Response> {
	let secret: string;
	try {
		secret = readNotificationsDispatchSecret(process.env);
	} catch (error) {
		console.error("[notifications-dispatch] configuração inválida", {
			name: error instanceof Error ? error.name : typeof error,
		});
		return respond(500);
	}
	if (!authorizationMatches(request.headers.get("authorization"), secret)) return respond(401);
	// Só depois da autenticação: quem não conhece o segredo não aprende o estado do deploy.
	if (!dispatchDatabaseConfigured("notifications-dispatch")) return respond(500);

	try {
		const result = await runDispatch();
		// errors > 0: resultado não gravado (a lease vence e a linha pode ser reenviada). O cron registra o 500.
		return Response.json(result, { status: result.errors > 0 ? 500 : 200 });
	} catch (error) {
		console.error("[notifications-dispatch] falha no envio do lote", {
			name: error instanceof Error ? error.name : typeof error,
			code: error instanceof Error && "code" in error ? error.code : undefined,
		});
		return respond(500);
	}
}

const methodNotAllowed = () => new Response(null, { status: 405, headers: { Allow: "POST" } });

export { methodNotAllowed as DELETE, methodNotAllowed as GET, methodNotAllowed as PATCH, methodNotAllowed as PUT };
