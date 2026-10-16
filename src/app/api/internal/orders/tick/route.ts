import { createHash, timingSafeEqual } from "node:crypto";

import { readNotificationsDispatchSecret } from "@/lib/config";
import { runOrdersTick } from "@/lib/orders/tick";

// Rota pública para o middleware (sem sessão): a autenticação é o segredo do header, chamado pelo cron.
// Usa o mesmo segredo do dispatch; o tick roda na role da aplicação (RLS), com o perfil de sistema de cada Bureau.
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
		console.error("[orders-tick] configuração inválida", {
			name: error instanceof Error ? error.name : typeof error,
		});
		return respond(500);
	}
	if (!authorizationMatches(request.headers.get("authorization"), secret)) return respond(401);

	try {
		const result = await runOrdersTick();
		// errors > 0: algum passo falhou e será repetido no próximo tick. O cron registra o 500.
		return Response.json(result, { status: result.errors > 0 ? 500 : 200 });
	} catch (error) {
		console.error("[orders-tick] falha no tick", {
			name: error instanceof Error ? error.name : typeof error,
			code: error instanceof Error && "code" in error ? error.code : undefined,
		});
		return respond(500);
	}
}

const methodNotAllowed = () => new Response(null, { status: 405, headers: { Allow: "POST" } });

export { methodNotAllowed as DELETE, methodNotAllowed as GET, methodNotAllowed as PATCH, methodNotAllowed as PUT };
