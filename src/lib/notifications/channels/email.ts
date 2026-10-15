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
		rendered = renderEmail(notification, notification.params);
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
