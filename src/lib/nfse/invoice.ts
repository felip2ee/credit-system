// Orquestra a NFS-e fora da transação do crédito. Nada aqui lança erro para o chamador de crédito
// e nada aqui toca carteira: a única escrita é set_nfse_status.
import { z } from "zod";

import { ASAAS_EVENT_INVOICE_AUTHORIZED, ASAAS_EVENT_INVOICE_ERROR } from "@/lib/asaas/client";
import { getAsaasClient } from "@/lib/asaas";
import { readNfseConfig, type NfseConfig } from "@/lib/config";
import {
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

// Agenda no Asaas e registra o resultado. Agendado = pending; erro = failed (a nova tentativa fica com o superadmin).
async function scheduleAndRecord(
	state: ConfigState,
	chargeId: string,
	paymentId: string,
	amount: string,
): Promise<ScheduleOutcome> {
	try {
		if (state.kind !== "ready") throw new Error("NFS-e config invalid");
		await getAsaasClient().scheduleInvoice({
			paymentId,
			amount,
			externalReference: chargeId,
			service: state.service,
		});
	} catch (error) {
		logFailure("agendamento", error);
		await tryRecordFailed(chargeId);
		return "failed";
	}
	// A nota já existe no Asaas: se só o registro falhar, o status fica e o evento INVOICE_AUTHORIZED o corrige.
	try {
		await setNfseStatus(chargeId, "pending");
	} catch (error) {
		logFailure("registro do agendamento", error);
	}
	return "pending";
}

// Depois do crédito, fora da transação. Nunca lança: a falha da nota não pode virar 500 nem desfazer o crédito.
export async function requestInvoiceForPayment(asaasPaymentId: string): Promise<ScheduleOutcome> {
	const state = nfseConfigState();
	if (state.kind === "off") return "not_requested";
	try {
		const charge: NfseCharge | null = await findNfseChargeByPayment(asaasPaymentId);
		if (!charge) return "unknown_charge";
		return await scheduleAndRecord(state, charge.chargeId, asaasPaymentId, charge.amount);
	} catch (error) {
		logFailure("pedido da nota", error);
		return "failed";
	}
}

// Reenvio do webhook de um pagamento já creditado: repara a nota que ficou em not_requested (processo caiu depois do
// crédito, ou o registro de "failed" falhou). set_nfse_status(pending) só muda not_requested, então só quem a "reivindica"
// agenda; nota pending, issued ou failed nunca é agendada de novo. Nunca lança.
// shortcut: reivindicar antes de agendar deixa a nota pending se o processo cair entre os dois passos; migrar para uma varredura de pending antigas se isso ocorrer.
export async function repairInvoiceForPayment(asaasPaymentId: string): Promise<ScheduleOutcome> {
	const state = nfseConfigState();
	if (state.kind === "off") return "not_requested";
	try {
		const charge: NfseCharge | null = await findNfseChargeByPayment(asaasPaymentId);
		if (!charge) return "unknown_charge";
		const claim = await setNfseStatus(charge.chargeId, "pending");
		if (!claim.ok || !claim.changed) return "not_requested";
		return await scheduleAndRecord(state, charge.chargeId, asaasPaymentId, charge.amount);
	} catch (error) {
		logFailure("reparo da nota", error);
		return "failed";
	}
}

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

const NUMBER_MAX = 50;
const URL_MAX = 2000;

const invoiceEventSchema = z.object({
	event: z.string().min(1),
	invoice: z.object({
		status: z.string().nullish(),
		number: z.union([z.string(), z.number()]).nullish(),
		pdfUrl: z.string().nullish(),
		payment: z.string().trim().min(1).max(200),
	}),
});

export type InvoiceEvent = z.infer<typeof invoiceEventSchema>;
export const parseInvoiceEvent = (raw: unknown) => invoiceEventSchema.safeParse(raw);

const EVENTS_BY_STATUS = new Set(["INVOICE_UPDATED", "INVOICE_SYNCHRONIZED"]);

// AUTHORIZED/ERROR pelo nome do evento; UPDATED/SYNCHRONIZED pelo status que carregam. O resto não muda a nota.
function targetStatus(event: InvoiceEvent): "issued" | "failed" | null {
	const name = EVENTS_BY_STATUS.has(event.event) ? `INVOICE_${event.invoice.status ?? ""}` : event.event;
	if (name === ASAAS_EVENT_INVOICE_AUTHORIZED) return "issued";
	if (name === ASAAS_EVENT_INVOICE_ERROR) return "failed";
	return null;
}

// Só valores que a função SQL aceita: número e URL fora do formato viram nulos em vez de recusar a emissão.
const cleanNumber = (value: string | number | null | undefined): string | null => {
	const text = value === null || value === undefined ? "" : String(value).trim();
	return text !== "" && text.length <= NUMBER_MAX ? text : null;
};
const cleanUrl = (value: string | null | undefined): string | null =>
	value && value.length <= URL_MAX && /^https:\/\/\S+$/.test(value) ? value : null;

export type InvoiceEventResult = "issued" | "failed" | "ignored" | "unknown_charge" | "unchanged";

// Evento de nota do Asaas. Idempotente (at-least-once): set_nfse_status não regride issued e repetir não muda nada.
// Erro de banco sobe: a rota responde 500 e o Asaas reenvia.
export async function applyInvoiceEvent(event: InvoiceEvent): Promise<InvoiceEventResult> {
	const status = targetStatus(event);
	if (!status) return "ignored";
	const charge = await findNfseChargeByPayment(event.invoice.payment);
	if (!charge) return "unknown_charge";
	const result = await setNfseStatus(
		charge.chargeId,
		status,
		status === "issued" ? { number: cleanNumber(event.invoice.number), url: cleanUrl(event.invoice.pdfUrl) } : {},
	);
	return result.ok && result.changed ? status : "unchanged";
}
