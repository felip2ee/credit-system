export type NotificationChannel = "email" | "whatsapp";

// Linha devolvida por claim_notifications (colunas em snake_case, como o pg entrega).
// Campos do outro canal vêm nulos.
export interface ClaimedNotification {
	id: string;
	lease_id: string;
	channel: NotificationChannel;
	recipient: string;
	params: Record<string, string>;
	attempts: number;
	opted_out: boolean;
	template_key: string;
	template_version: number;
	template_params: string[];
	email_subject: string | null;
	email_html: string | null;
	email_text: string | null;
	wa_template_name: string | null;
	wa_language: string | null;
}

export type SendResult =
	| { ok: true; providerMessageId: string }
	| { ok: false; permanent: boolean; code: string };
