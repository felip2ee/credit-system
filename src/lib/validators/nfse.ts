import { z } from "zod";

export const retryNfseSchema = z.object({ chargeId: z.string().uuid("Cobrança inválida.") });
