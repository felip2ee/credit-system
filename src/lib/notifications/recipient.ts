import { maskRecipient as maskEmail } from "@/lib/auth/email";
import { isValidEmail } from "@/lib/utils";

import type { NotificationChannel } from "./types";

const BR_PREFIX = "+55";
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;
const VISIBLE_TAIL = 4;

// Celular tem 9 na frente do número de 8 dígitos (11 dígitos com DDD); fixo começa em 2 a 5.
function brazilianNational(digits: string): string | null {
	if (digits.length !== 10 && digits.length !== 11) return null;
	const ddd = digits.slice(0, 2);
	if (ddd < "11" || ddd.includes("0")) return null;
	const subscriber = digits.slice(2);
	const isMobile = digits.length === 11;
	if (isMobile ? subscriber[0] !== "9" : !/^[2-5]/.test(subscriber)) return null;
	return BR_PREFIX + digits;
}

// E164Br: aceita número com "+" (qualquer país) ou número brasileiro sem "+" (com ou sem 55).
// Prefixo de operadora (0 inicial) e celular de 10 dígitos (sem o 9) dão null.
export function toE164(input: string): string | null {
	const cleaned = input.trim().replace(/[\s().-]/g, "");
	if (cleaned.startsWith("+")) {
		const digits = cleaned.slice(1);
		return /^[1-9]\d+$/.test(digits) && digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS
			? `+${digits}`
			: null;
	}
	if (!/^\d+$/.test(cleaned)) return null;
	if (cleaned.length === 10 || cleaned.length === 11) return brazilianNational(cleaned);
	if ((cleaned.length === 12 || cleaned.length === 13) && cleaned.startsWith("55")) {
		return brazilianNational(cleaned.slice(2));
	}
	return null;
}

// O mesmo celular brasileiro chega com e sem o nono dígito (a Meta ainda devolve wa_id sem ele).
// O primeiro item é sempre a forma recebida.
export function brazilianVariants(e164: string): string[] {
	if (!e164.startsWith(BR_PREFIX)) return [e164];
	const national = e164.slice(BR_PREFIX.length);
	if (national.length === 11 && national[2] === "9") {
		return [e164, `${BR_PREFIX}${national.slice(0, 2)}${national.slice(3)}`];
	}
	if (national.length === 10 && /^[6-9]/.test(national.slice(2))) {
		return [e164, `${BR_PREFIX}${national.slice(0, 2)}9${national.slice(2)}`];
	}
	return [e164];
}

export function normalizeEmail(input: string): string | null {
	const email = input.trim().toLowerCase();
	return isValidEmail(email) ? email : null;
}

// Telefone: DDI +55 e os 4 últimos dígitos (+55*******5615). Fora do Brasil o DDI tem
// tamanho variável, então só o "+" e os 4 últimos dígitos aparecem.
export function maskRecipient(channel: NotificationChannel, recipient: string): string {
	if (channel === "email") return maskEmail(recipient);
	const prefix = recipient.startsWith(BR_PREFIX) ? BR_PREFIX : "+";
	const digits = recipient.slice(prefix.length);
	const tail = digits.slice(-VISIBLE_TAIL);
	return prefix + "*".repeat(Math.max(digits.length - tail.length, 0)) + tail;
}
