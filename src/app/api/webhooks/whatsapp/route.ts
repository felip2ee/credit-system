import { readWebhookDatabaseUrl, readWhatsappConfig } from "@/lib/config";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import {
	WHATSAPP_MAX_BODY_BYTES,
	WHATSAPP_SIGNATURE_HEADER,
	applyWhatsappWebhook,
	parseWhatsappWebhook,
	signatureMatches,
	verifyTokenMatches,
} from "@/lib/notifications/whatsapp-webhook";

// Rota pública (sem sessão): GET se autentica pelo verify token; POST, pela assinatura HMAC do corpo bruto.
const MAX_CHALLENGE_DIGITS = 64;

const respond = (status: number) => new Response(null, { status });

function readConfig() {
	try {
		const config = readWhatsappConfig(process.env);
		if (config) return config;
		console.error(
			"[whatsapp-webhook] WhatsApp desligado: WHATSAPP_DRIVER vazio",
		);
	} catch (error) {
		console.error("[whatsapp-webhook] configuração inválida", {
			name: error instanceof Error ? error.name : typeof error,
		});
	}
	return null;
}

// Só nome e código: nunca o corpo, o remetente, o texto nem o header de assinatura.
function logFailure(error: unknown): void {
	console.error("[whatsapp-webhook] falha ao aplicar o evento", {
		name: error instanceof Error ? error.name : typeof error,
		code: error instanceof Error && "code" in error ? error.code : undefined,
	});
}

export async function GET(request: Request): Promise<Response> {
	const config = readConfig();
	if (!config) return respond(500);

	const params = new URL(request.url).searchParams;
	const challenge = params.get("hub.challenge") ?? "";
	if (
		params.get("hub.mode") !== "subscribe" ||
		!verifyTokenMatches(params.get("hub.verify_token"), config.verifyToken) ||
		!new RegExp(`^\\d{1,${MAX_CHALLENGE_DIGITS}}$`).test(challenge)
	) {
		return respond(403);
	}
	return new Response(challenge, {
		status: 200,
		headers: { "content-type": "text/plain" },
	});
}

export async function POST(request: Request): Promise<Response> {
	const config = readConfig();
	if (!config) return respond(500);
	try {
		readWebhookDatabaseUrl(process.env);
	} catch (error) {
		console.error("[whatsapp-webhook] configuração inválida", {
			name: error instanceof Error ? error.name : typeof error,
		});
		return respond(500);
	}

	const rawBody = Buffer.from(await request.arrayBuffer());
	if (rawBody.length > WHATSAPP_MAX_BODY_BYTES) return respond(413);
	if (
		!signatureMatches(
			rawBody,
			request.headers.get(WHATSAPP_SIGNATURE_HEADER),
			config.appSecret,
		)
	) {
		return respond(401);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(rawBody.toString("utf8"));
	} catch {
		return respond(400);
	}

	try {
		const counts = await applyWhatsappWebhook(
			parseWhatsappWebhook(raw, config.phoneNumberId),
			getWebhookPool(),
		);
		console.info("[whatsapp-webhook] evento aplicado", counts);
		return respond(200);
	} catch (error) {
		logFailure(error);
		return respond(500);
	}
}
