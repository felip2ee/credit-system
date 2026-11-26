"use server";

import { hashPassword } from "better-auth/crypto";
import { headers } from "next/headers";

import { confirmEmailVerification, isRegisterIpAllowed, registerClient, type RegisterFailure } from "@/lib/account/queries";
import { requestMeta } from "@/lib/account/request-meta";
import { generateEmailToken } from "@/lib/account/secrets";
import { config } from "@/lib/config";
import { toE164 } from "@/lib/notifications/recipient";
import { emailTokenSchema } from "@/lib/validators/account";
import { registerSchema } from "@/lib/validators/register";

// Ações públicas (sem sessão): a conta ainda não existe ou o token do e-mail é a credencial.
export interface RegisterActionResult {
	error: string | null;
}

const INVALID_PHONE = "Celular inválido. Use DDD e número.";
const REGISTER_FAILED = "Não foi possível concluir o cadastro. Tente novamente.";
const INVALID_LINK = "Link inválido ou expirado. A confirmação de e-mail não é mais necessária: use o portal normalmente.";
const CONFIRM_FAILED = "Não foi possível confirmar o e-mail. Tente novamente.";

const REGISTER_MESSAGES: Record<RegisterFailure, string> = {
	rate_limited: "Muitas tentativas de cadastro. Tente de novo em uma hora.",
	bureau_not_found: "Bureau não encontrado.",
	outdated_terms: "Os termos foram atualizados. Recarregue a página e aceite a nova versão.",
	document_in_use: "Documento já cadastrado neste Bureau. Peça o acesso ao Bureau.",
	email_in_use: "E-mail já cadastrado. Entre com sua senha ou recupere o acesso.",
	invalid_input: "Dados inválidos.",
};

const CONFIRM_MESSAGES = {
	invalid: INVALID_LINK,
	expired: "Link inválido ou expirado. A confirmação de e-mail não é mais necessária: use o portal normalmente.",
};

// Só nome e código do erro: nunca documento, e-mail, telefone, token nem a mensagem do driver.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[account] ${step} falhou`, meta);
}

export async function registerClientAction(values: unknown): Promise<RegisterActionResult> {
	const parsed = registerSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? REGISTER_MESSAGES.invalid_input };
	const input = parsed.data;

	const phoneE164 = toE164(input.phone);
	if (!phoneE164) return { error: INVALID_PHONE };

	try {
		// Antes do scrypt: IP no limite não gasta CPU.
		const meta = requestMeta(await headers());
		if (!(await isRegisterIpAllowed(meta.ip))) return { error: REGISTER_MESSAGES.rate_limited };
		const result = await registerClient({
			slug: input.slug,
			type: input.type,
			name: input.name,
			documentDigits: input.documentDigits,
			email: input.email,
			phoneE164,
			passwordHash: await hashPassword(input.password),
			termsVersion: input.termsVersion,
			privacyVersion: input.privacyVersion,
			...meta,
			emailToken: generateEmailToken(),
			siteUrl: config.betterAuthUrl,
			referralCode: input.referralCode,
		});
		return { error: result.ok ? null : REGISTER_MESSAGES[result.reason] };
	} catch (error) {
		logFailure("registerClientAction", error);
		return { error: REGISTER_FAILED };
	}
}

export async function confirmEmailAction(token: unknown): Promise<RegisterActionResult> {
	const parsed = emailTokenSchema.safeParse(token);
	if (!parsed.success) return { error: INVALID_LINK };

	try {
		const result = await confirmEmailVerification(parsed.data);
		return { error: result.ok ? null : CONFIRM_MESSAGES[result.reason] };
	} catch (error) {
		logFailure("confirmEmailAction", error);
		return { error: CONFIRM_FAILED };
	}
}
