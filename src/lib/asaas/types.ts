export type PixChargeInput = {
	// Reais, string decimal com até 2 casas.
	amount: string;
	// Referência nossa, devolvida pelo Asaas; não é a chave de busca do webhook.
	externalReference: string;
	description: string;
};

// asaasPaymentId fica no servidor: nunca vai ao navegador.
export type PixChargeResult = {
	asaasPaymentId: string;
	pixPayload: string;
	qrImageBase64: string;
};

export type AsaasClient = {
	createPixCharge(input: PixChargeInput): Promise<PixChargeResult>;
};
