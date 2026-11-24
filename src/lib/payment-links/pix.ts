// Pix do link de pagamento (/pagar/<token>), sem sessão. A linha nasce no banco antes do Asaas (payment_link_charge_reserve,
// 058), o Asaas é chamado aqui e o id do pagamento volta por payment_link_charge_bind. A baixa é do webhook
// (apply_payment_link_charge): nada aqui credita carteira nem avança pedido.
// Nada aqui grava em log ou erro: token, documento, e-mail, código Pix ou corpo do Asaas.
import QRCode from "qrcode";

import { getAsaasClient } from "@/lib/asaas";
import { pool } from "@/lib/db/pool";

export type LinkPixCharge = { pixPayload: string; qrDataUrl: string; expiresAt: Date; amount: string };

export type LinkPixResult =
	| ({ ok: true } & LinkPixCharge)
	| { ok: false; reason: "in_progress" | "unavailable" | "rate_limited" | "amount_out_of_range" | "failed" };

type ReserveRow = {
	result: "created" | "reused" | "in_progress" | "unavailable" | "amount_out_of_range" | "rate_limited";
	charge_id: string | null;
	external_reference: string | null;
	amount: string | null;
	pix_payload: string | null;
	expires_at: Date | null;
	// Pagamento Asaas da cobrança que a reserva fechou: cancelado lá, melhor esforço.
	stale_asaas_payment_id: string | null;
};

const QR_WIDTH = 208;

// Só nome e código: sem valores, documento nem corpo do Asaas.
function logFailure(step: string, error: unknown): void {
	console.error(`[payment-link-pix] falhou em ${step}`, {
		name: error instanceof Error ? error.name : typeof error,
		code: error instanceof Error && "code" in error ? error.code : undefined,
	});
}

const toCharge = async (pixPayload: string, expiresAt: Date, amount: string): Promise<LinkPixResult> => ({
	ok: true,
	pixPayload,
	qrDataUrl: await QRCode.toDataURL(pixPayload, { margin: 1, width: QR_WIDTH }),
	expiresAt,
	amount,
});

// Fecha a linha reservada: o Asaas não criou a cobrança (ou não sabemos). Se ele a criou, o webhook a baixa pela referência.
async function cancelReserved(chargeId: string): Promise<void> {
	try {
		await pool.query("select payment_link_charge_cancel($1)", [chargeId]);
	} catch (error) {
		logFailure("cancelar reserva", error);
	}
}

// Cancela no Asaas os Pix que deixaram de valer (cobrança trocada ou link substituído). Melhor esforço: a falha só vai ao
// log (id do pagamento, nunca token nem documento) e nunca trava quem chamou. Pago depois mesmo assim o webhook baixa.
export async function cancelAsaasPayments(asaasPaymentIds: string[]): Promise<void> {
	if (asaasPaymentIds.length === 0) return;
	await Promise.all(
		asaasPaymentIds.map((asaasPaymentId) =>
			Promise.resolve()
				.then(() => getAsaasClient().cancelPixCharge(asaasPaymentId))
				.catch((error: unknown) => {
					console.error("[payment-link-pix] falhou ao cancelar Pix antigo no Asaas", {
						asaasPaymentId,
						name: error instanceof Error ? error.name : typeof error,
					});
				}),
		),
	);
}

// Cria ou reusa a cobrança Pix pendente do link. `linkId` vem de resolvePaymentLink (link ativo, não vencido).
export async function getOrCreateLinkPixCharge(linkId: string): Promise<LinkPixResult> {
	let row: ReserveRow | undefined;
	try {
		row = (await pool.query<ReserveRow>("select * from payment_link_charge_reserve($1)", [linkId])).rows[0];
	} catch (error) {
		logFailure("reservar", error);
		return { ok: false, reason: "failed" };
	}
	if (!row) return { ok: false, reason: "failed" };
	if (row.stale_asaas_payment_id) await cancelAsaasPayments([row.stale_asaas_payment_id]);
	if (row.result === "reused" && row.pix_payload && row.expires_at && row.amount) {
		return toCharge(row.pix_payload, row.expires_at, row.amount);
	}
	if (row.result !== "created" || !row.charge_id || !row.external_reference || !row.amount || !row.expires_at) {
		return { ok: false, reason: row.result === "reused" || row.result === "created" ? "failed" : row.result };
	}

	const { charge_id: chargeId, external_reference: externalReference, amount, expires_at: expiresAt } = row;
	try {
		const payer = (
			await pool.query<{ payer_name: string; payer_document: string; payer_email: string; holder_id: string }>(
				"select * from payment_link_charge_payer($1)",
				[chargeId],
			)
		).rows[0];
		if (!payer) throw new Error("titular sem dados de pagador");
		const asaas = getAsaasClient();
		// Referência estável (titular): cobranças repetidas reusam o cliente em vez de criar outro com o documento completo.
		const customerReference = `holder:${payer.holder_id}`;
		const customerId =
			(await asaas.findCustomerByExternalReference(customerReference)) ??
			(
				await asaas.createCustomer({
					name: payer.payer_name,
					cpfCnpj: payer.payer_document,
					email: payer.payer_email,
					externalReference: customerReference,
				})
			).asaasCustomerId;
		const pix = await asaas.createPixCharge({
			customerId,
			amount,
			externalReference,
			description: "Consulta - pagamento por link",
		});
		const bound = await pool
			.query<{ bound: boolean }>("select payment_link_charge_bind($1, $2, $3) as bound", [
				chargeId,
				pix.asaasPaymentId,
				pix.pixPayload,
			])
			.then((r) => r.rows[0].bound)
			.catch((error) => {
				logFailure("bind", error);
				return false;
			});
		// Sem bind a cobrança existe no Asaas: o webhook a acha pela referência externa. Só ids, para a conciliação.
		if (!bound) console.error("[payment-link-pix] COBRANÇA sem ligação no banco", { chargeId, externalReference });
		return toCharge(pix.pixPayload, expiresAt, amount);
	} catch (error) {
		logFailure("criar cobrança", error);
		await cancelReserved(chargeId);
		return { ok: false, reason: "failed" };
	}
}
