import { z } from "zod";

// walletId do Asaas: texto curto sem espaço nem pontuação (a coluna aceita até 64).
const walletIdField = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9-]{8,64}$/, "Informe um walletId válido do Asaas.");

// Mesmo formato de affiliatePctField, mas o sócio precisa de mais de 0 (check da coluna).
const partnerPctField = z
	.string()
	.trim()
	.regex(/^\d{1,3}(\.\d{1,2})?$/, "Informe uma porcentagem de 0,01 a 100, com até 2 casas.")
	.refine((v) => Number(v) > 0 && Number(v) <= 100, "A porcentagem vai de 0,01 a 100.");

export const partnerSchema = z.object({
	id: z.string().uuid("Sócio inválido.").optional(),
	name: z.string().trim().min(1, "Informe o nome.").max(120, "O nome passa de 120 caracteres."),
	asaasWalletId: walletIdField,
	pct: partnerPctField,
	active: z.boolean(),
});
export type PartnerInput = z.infer<typeof partnerSchema>;

// app_runtime não tem delete em bureau_asaas_wallets (065): o walletId só se troca, não se remove.
export const bureauWalletSchema = z.object({
	bureauId: z.string().uuid("Bureau inválido."),
	asaasWalletId: walletIdField,
});
export type BureauWalletInput = z.infer<typeof bureauWalletSchema>;
