import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";
import { z } from "zod";

import { brazilianVariants, toE164 } from "./recipient";

export const WHATSAPP_SIGNATURE_HEADER = "x-hub-signature-256";
export const WHATSAPP_MAX_BODY_BYTES = 262_144;

const OPT_OUT_KEYWORDS = new Set([
	"PARAR",
	"SAIR",
	"STOP",
	"CANCELAR",
	"DESCADASTRAR",
]);

// Meta assina o corpo bruto: calcule sobre os bytes recebidos, antes de qualquer JSON.parse.
export function signatureMatches(
	rawBody: Buffer,
	header: string | null,
	appSecret: string,
): boolean {
	if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
	const expected = createHmac("sha256", appSecret).update(rawBody).digest();
	const received = Buffer.from(header.slice("sha256=".length), "hex");
	return (
		received.length === expected.length && timingSafeEqual(received, expected)
	);
}

// Hash dos dois lados iguala o tamanho; timingSafeEqual não vaza o prefixo comum.
export function verifyTokenMatches(
	received: string | null,
	expected: string,
): boolean {
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(received ?? ""), digest(expected));
}

// OptOutKeyword: a mensagem inteira, sem espaço nas pontas, caixa ou acento. Palavra dentro de frase não vale.
export function isOptOutKeyword(text: string): boolean {
	const normalized = text
		.trim()
		.toUpperCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "");
	return OPT_OUT_KEYWORDS.has(normalized);
}

export type WhatsappStatus = {
	providerMessageId: string;
	status: "sent" | "delivered" | "read" | "failed";
	errorCode: string | null;
	occurredAt: Date;
};

export type ParsedWhatsappWebhook = {
	statuses: WhatsappStatus[];
	optOutSenders: string[];
};

const envelopeSchema = z.object({
	object: z.literal("whatsapp_business_account"),
	entry: z.array(z.unknown()),
});

const changeSchema = z.object({
	field: z.literal("messages"),
	value: z.object({
		metadata: z.object({ phone_number_id: z.string() }),
		statuses: z.array(z.unknown()).optional(),
		messages: z.array(z.unknown()).optional(),
	}),
});

const statusSchema = z.object({
	id: z.string().trim().min(1).max(200),
	status: z.enum(["sent", "delivered", "read", "failed"]),
	timestamp: z.coerce.number().int().positive(),
	errors: z
		.array(z.object({ code: z.union([z.number(), z.string()]) }))
		.optional(),
});

const messageSchema = z.object({
	from: z.string().regex(/^\d{8,15}$/),
	type: z.literal("text"),
	text: z.object({ body: z.string().max(4096) }),
});

// Item fora do formato é ignorado: não derruba o lote.
function validItems<T>(
	schema: z.ZodType<T>,
	items: unknown[] | undefined,
): T[] {
	return (items ?? []).flatMap((item) => {
		const parsed = schema.safeParse(item);
		return parsed.success ? [parsed.data] : [];
	});
}

export function parseWhatsappWebhook(
	raw: unknown,
	phoneNumberId: string,
): ParsedWhatsappWebhook {
	const result: ParsedWhatsappWebhook = { statuses: [], optOutSenders: [] };
	const envelope = envelopeSchema.safeParse(raw);
	if (!envelope.success) return result;

	for (const change of envelope.data.entry.flatMap((entry) => {
		const changes = (entry as { changes?: unknown } | null)?.changes;
		return Array.isArray(changes) ? changes : [];
	})) {
		const parsed = changeSchema.safeParse(change);
		if (
			!parsed.success ||
			parsed.data.value.metadata.phone_number_id !== phoneNumberId
		)
			continue;
		for (const s of validItems(statusSchema, parsed.data.value.statuses)) {
			result.statuses.push({
				providerMessageId: s.id,
				status: s.status,
				errorCode: s.errors?.[0] ? String(s.errors[0].code) : null,
				occurredAt: new Date(s.timestamp * 1000),
			});
		}
		for (const m of validItems(messageSchema, parsed.data.value.messages)) {
			if (isOptOutKeyword(m.text.body)) result.optOutSenders.push(m.from);
		}
	}
	return result;
}

export type WhatsappApplyCounts = {
	applied: number;
	duplicate: number;
	orphan: number;
	ignored: number;
	optOut: number;
};

// Qualquer erro de banco sobe: o handler responde 500 e a Meta reenvia. As funções SQL são idempotentes.
export async function applyWhatsappWebhook(
	parsed: ParsedWhatsappWebhook,
	pool: Pick<Pool, "query">,
): Promise<WhatsappApplyCounts> {
	const counts: WhatsappApplyCounts = {
		applied: 0,
		duplicate: 0,
		orphan: 0,
		ignored: 0,
		optOut: 0,
	};
	for (const s of parsed.statuses) {
		const { rows } = await pool.query<{
			result: "applied" | "duplicate" | "orphan" | "ignored";
		}>("select public.apply_whatsapp_status($1, $2, $3, $4) as result", [
			s.providerMessageId,
			s.status,
			s.errorCode,
			s.occurredAt,
		]);
		counts[rows[0].result] += 1;
	}
	for (const from of parsed.optOutSenders) {
		const e164 = toE164(`+${from}`);
		if (!e164) continue;
		for (const variant of brazilianVariants(e164)) {
			await pool.query(
				"select public.record_notification_opt_out('whatsapp', $1)",
				[variant],
			);
		}
		counts.optOut += 1;
	}
	return counts;
}
