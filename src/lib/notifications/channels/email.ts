import { sendMail, senderDomain } from "@/lib/email/mailer";

import { classifySmtpError, TemplateRenderError } from "../errors";
import { renderEmail } from "../render";
import type { ClaimedNotification, SendResult } from "../types";

export async function sendEmailNotification(notification: ClaimedNotification): Promise<SendResult> {
	const domain = senderDomain();
	// SMTP sem configuração é erro nosso (como no WhatsApp): tenta de novo depois do ajuste, sem queimar a notificação.
	if (!domain) return { ok: false, permanent: false, code: "config_error" };

	let rendered;
	try {
		// {{siteUrl}} (logo por URL absoluta) vem do ambiente e vence qualquer parâmetro enfileirado de mesmo nome.
		const siteUrl = (process.env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
		rendered = renderEmail(notification, { ...notification.params, siteUrl });
	} catch (error) {
		if (error instanceof TemplateRenderError) return { ok: false, permanent: error.permanent, code: error.code };
		throw error;
	}

	try {
		const { messageId } = await sendMail({
			to: notification.recipient,
			...rendered,
			// Message-ID fixo por notificação: a nova tentativa não vira outra mensagem no log do provedor.
			messageId: `<${notification.id}@${domain}>`,
		});
		return { ok: true, providerMessageId: messageId };
	} catch (error) {
		return { ok: false, ...classifySmtpError(error) };
	}
}
