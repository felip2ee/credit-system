import { readDispatchDatabaseUrl, readWebhookDatabaseUrl } from "@/lib/config";

type Reader = (env: NodeJS.ProcessEnv) => string;

// Valida o DSN da role antes do pool abrir. Loga só o nome do erro; a rota responde 500 quando for false.
function check(tag: string, read: Reader): boolean {
	try {
		read(process.env);
		return true;
	} catch (error) {
		console.error(`[${tag}] configuração inválida`, {
			name: error instanceof Error ? error.name : typeof error,
		});
		return false;
	}
}

export const webhookDatabaseConfigured = (tag: string) => check(tag, readWebhookDatabaseUrl);
export const dispatchDatabaseConfigured = (tag: string) => check(tag, readDispatchDatabaseUrl);
