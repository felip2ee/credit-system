import { createHash, timingSafeEqual } from "node:crypto";

import { readNotificationsDispatchSecret, readWebhookDatabaseUrl } from "@/lib/config";
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
		readWebhookDatabaseUrl(process.env);
	} catch (error) {
		console.error("[notifications-dispatch] configuração inválida", {
			name: error instanceof Error ? error.name : typeof error,
		});
		return respond(500);
	}
	if (!authorizationMatches(request.headers.get("authorization"), secret)) return respond(401);

	try {
		return Response.json(await runDispatch());
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
