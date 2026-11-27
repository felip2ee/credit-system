import { z } from "zod";

// walletId do Asaas é um UUID. O Asaas não oferece API para validar o walletId de outra conta.
export const asaasWalletIdField = z
	.string()
	.trim()
	.uuid("Informe o walletId do Asaas no formato 00000000-0000-0000-0000-000000000000.")
	.transform((v) => v.toLowerCase());

// O walletId pode faltar aqui: se a carteira já guarda um, o modo asaas o reaproveita. A regra "asaas exige walletId" vive em setPayoutMethod.
export const setPayoutMethodSchema = z.object({
	method: z.enum(["asaas", "pix"], { message: "Escolha como receber." }),
	asaasWalletId: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), asaasWalletIdField.optional()),
});

export type SetPayoutMethodInput = z.infer<typeof setPayoutMethodSchema>;
