// Orquestra a NFS-e fora da transação do crédito. Nada aqui lança erro para o chamador de crédito
// e nada aqui toca carteira: a única escrita é set_nfse_status.
import { z } from "zod";

import {
	ASAAS_EVENT_INVOICE_AUTHORIZED,
	ASAAS_EVENT_INVOICE_CANCELED,
	ASAAS_EVENT_INVOICE_ERROR,
	AsaasOutcomeUnknownError,
} from "@/lib/asaas/client";
import { getAsaasClient } from "@/lib/asaas";
import type { AsaasClient, ExistingInvoice } from "@/lib/asaas/types";
import { readNfseConfig, type NfseConfig } from "@/lib/config";
import {
	findNfseChargeByInvoice,
	findNfseChargeByPayment,
	findNfseRetryTarget,
	setNfseStatus,
	type NfseCharge,
} from "./queries";
import type { DbIdentity } from "@/lib/db/transaction";

// Só nome do erro: nada de chave, corpo do Asaas nem dados da cobrança.
function logFailure(step: string, error: unknown): void {
	console.error(`[nfse] ${step} falhou`, {
		name: error instanceof Error ? error.name : typeof error,
		code: error instanceof Error && "code" in error ? error.code : undefined,
	});
}

// Melhor esforço: se nem o registro de "failed" grava, a nota fica como está e o erro só vai ao log.
async function tryRecordFailed(chargeId: string): Promise<void> {
	try {
		await setNfseStatus(chargeId, "failed");
	} catch (error) {
		logFailure("registro da falha", error);
	}
}

type ConfigState = { kind: "off" } | { kind: "invalid" } | { kind: "ready"; service: NfseConfig };

function nfseConfigState(): ConfigState {
	try {
		const service = readNfseConfig(process.env);
		return service ? { kind: "ready", service } : { kind: "off" };
	} catch (error) {
		logFailure("configuração", error);
		return { kind: "invalid" };
	}
}

export const isNfseConfigured = (): boolean => nfseConfigState().kind !== "off";

export type ScheduleOutcome = "not_requested" | "unknown_charge" | "pending" | "failed";

// Só o que a função SQL aceita: número e URL fora do formato viram nulos em vez de recusar a emissão.
const NUMBER_MAX = 50;
const URL_MAX = 2000;
const cleanNumber = (value: string | number | null | undefined): string | null => {
	const text = value === null || value === undefined ? "" : String(value).trim();
	return text !== "" && text.length <= NUMBER_MAX ? text : null;
};
const cleanUrl = (value: string | null | undefined): string | null =>
	value && value.length <= URL_MAX && /^https:\/\/\S+$/.test(value) ? value : null;

// Grava o id da nota no Asaas (e, se ela já saiu, a emissão). Falhar aqui não perde a nota: o evento a casa pelo pagamento.
async function recordInvoice(chargeId: string, invoice: ExistingInvoice): Promise<void> {
	try {
		if (invoice.status === "AUTHORIZED") {
			await setNfseStatus(chargeId, "issued", {
				number: cleanNumber(invoice.number),
				url: cleanUrl(invoice.pdfUrl),
				invoiceId: invoice.asaasInvoiceId,
			});
		} else {
			await setNfseStatus(chargeId, "pending", { invoiceId: invoice.asaasInvoiceId });
		}
	} catch (error) {
		logFailure("registro da nota", error);
	}
}

// POST /v3/invoices não tem idempotência. Por isso: (1) consulta as notas do pagamento e adota a que existir;
// (2) só então agenda; (3) timeout, rede e 5xx são resultado DESCONHECIDO: a nota fica pending e a próxima
// reivindicação (pending com mais de 10 min) consulta o Asaas de novo. Só erro conhecido registra failed.
async function scheduleAndRecord(
	state: ConfigState,
	chargeId: string,
	paymentId: string,
	amount: string,
): Promise<ScheduleOutcome> {
	let client: AsaasClient;
	let existing: ExistingInvoice | undefined;
	try {
		if (state.kind !== "ready") throw new Error("NFS-e config invalid");
		client = getAsaasClient();
		[existing] = await client.findInvoicesByPayment(paymentId);
	} catch (error) {
		logFailure("consulta das notas", error);
		if (error instanceof AsaasOutcomeUnknownError) return "pending";
		await tryRecordFailed(chargeId);
		return "failed";
	}
	if (existing) {
		await recordInvoice(chargeId, existing);
		return "pending";
	}
	try {
		const scheduled = await client.scheduleInvoice({
			paymentId,
			amount,
			externalReference: chargeId,
			service: state.service,
		});
		await recordInvoice(chargeId, { asaasInvoiceId: scheduled.asaasInvoiceId, status: "SCHEDULED", number: null, pdfUrl: null });
		return "pending";
	} catch (error) {
		logFailure("agendamento", error);
		if (error instanceof AsaasOutcomeUnknownError) return "pending";
		await tryRecordFailed(chargeId);
		return "failed";
	}
}

// set_nfse_status(pending) muda not_requested e também reivindica pending com mais de 10 min (quem a perdeu: o processo
// caiu, ou o resultado do Asaas era desconhecido). Só quem reivindica agenda; nota pending recente, issued ou failed
// nunca é agendada de novo. Nunca lança.
async function claimAndSchedule(asaasPaymentId: string, step: string): Promise<ScheduleOutcome> {
	const state = nfseConfigState();
	if (state.kind === "off") return "not_requested";
	try {
		const charge: NfseCharge | null = await findNfseChargeByPayment(asaasPaymentId);
		if (!charge) return "unknown_charge";
		const claim = await setNfseStatus(charge.chargeId, "pending");
		if (!claim.ok || !claim.changed) return "not_requested";
		return await scheduleAndRecord(state, charge.chargeId, asaasPaymentId, charge.amount);
	} catch (error) {
		// Estado desconhecido (a reivindicação pode ter gravado): não registra failed. A nota pending é reivindicada de novo.
		logFailure(step, error);
		return "failed";
	}
}

// Depois do crédito, fora da transação. Nunca lança: a falha da nota não pode virar 500 nem desfazer o crédito.
export const requestInvoiceForPayment = (asaasPaymentId: string): Promise<ScheduleOutcome> =>
	claimAndSchedule(asaasPaymentId, "pedido da nota");

// Reenvio do webhook de um pagamento já creditado: repara a nota que ficou em not_requested ou presa em pending há mais
// de 10 min (reivindicação do SQL); nota recente, issued ou failed fica como está.
export const repairInvoiceForPayment = (asaasPaymentId: string): Promise<ScheduleOutcome> =>
	claimAndSchedule(asaasPaymentId, "reparo da nota");

// Nova tentativa depois de request_nfse_retry (a cobrança já está pending). Nunca lança.
export async function rescheduleInvoice(identity: DbIdentity, chargeId: string): Promise<ScheduleOutcome> {
	const state = nfseConfigState();
	if (state.kind === "off") return "not_requested";
	try {
		const target = await findNfseRetryTarget(identity, chargeId);
		if (!target) {
			await tryRecordFailed(chargeId);
			return "unknown_charge";
		}
		return await scheduleAndRecord(state, chargeId, target.asaasPaymentId, target.amount);
	} catch (error) {
		logFailure("nova tentativa", error);
		await tryRecordFailed(chargeId);
		return "failed";
	}
}

const invoiceEventSchema = z.object({
	event: z.string().min(1),
	invoice: z.object({
		status: z.string().nullish(),
		number: z.union([z.string(), z.number()]).nullish(),
		pdfUrl: z.string().nullish(),
		payment: z.string().trim().min(1).max(200),
		// Id da nota no Asaas: casa o evento com a cobrança antes de recorrer ao pagamento.
		id: z.string().trim().min(1).max(100).nullish(),
	}),
});

export type InvoiceEvent = z.infer<typeof invoiceEventSchema>;
export const parseInvoiceEvent = (raw: unknown) => invoiceEventSchema.safeParse(raw);

const EVENTS_BY_STATUS = new Set(["INVOICE_UPDATED", "INVOICE_SYNCHRONIZED"]);

// AUTHORIZED/ERROR/CANCELED pelo nome do evento; UPDATED/SYNCHRONIZED pelo status que carregam. O resto não muda a nota.
// CANCELLATION_DENIED e PROCESSING_CANCELLATION ficam de fora de propósito: a nota segue válida.
function targetStatus(event: InvoiceEvent): "issued" | "failed" | "canceled" | null {
	const name = EVENTS_BY_STATUS.has(event.event) ? `INVOICE_${event.invoice.status ?? ""}` : event.event;
	if (name === ASAAS_EVENT_INVOICE_AUTHORIZED) return "issued";
	if (name === ASAAS_EVENT_INVOICE_ERROR) return "failed";
	if (name === ASAAS_EVENT_INVOICE_CANCELED) return "canceled";
	return null;
}

// Casa o evento pelo id da nota; sem ele, pelo pagamento. Cobrança com OUTRA nota gravada: o evento é de uma nota
// antiga (A) e não pode matar a nota válida (B), então "ignored".
async function findEventCharge(event: InvoiceEvent): Promise<NfseCharge | "ignored" | null> {
	const eventInvoiceId = event.invoice.id;
	const byInvoice = eventInvoiceId ? await findNfseChargeByInvoice(eventInvoiceId) : null;
	if (byInvoice) return byInvoice;
	const byPayment = await findNfseChargeByPayment(event.invoice.payment);
	if (byPayment && eventInvoiceId && byPayment.invoiceId && byPayment.invoiceId !== eventInvoiceId) return "ignored";
	return byPayment;
}

export type InvoiceEventResult = "issued" | "failed" | "canceled" | "ignored" | "unknown_charge" | "unchanged";

// Evento de nota do Asaas. Idempotente (at-least-once): set_nfse_status não regride issued e repetir não muda nada.
// Erro de banco sobe: a rota responde 500 e o Asaas reenvia.
export async function applyInvoiceEvent(event: InvoiceEvent): Promise<InvoiceEventResult> {
	const status = targetStatus(event);
	if (!status) return "ignored";
	const charge = await findEventCharge(event);
	if (charge === "ignored") return "ignored";
	if (!charge) return "unknown_charge";
	const result = await setNfseStatus(
		charge.chargeId,
		status,
		status === "issued" ? { number: cleanNumber(event.invoice.number), url: cleanUrl(event.invoice.pdfUrl) } : {},
	);
	return result.ok && result.changed ? status : "unchanged";
}
