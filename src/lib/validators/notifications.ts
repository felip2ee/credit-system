import { z } from "zod";

import { uuidSchema } from "./id";

export const retryNotificationSchema = z.object({ id: uuidSchema });

export const sendTestNotificationSchema = z.object({
	channel: z.enum(["email", "whatsapp"], { message: "Canal inválido." }),
	recipient: z.string().trim().min(1, "Informe o destinatário.").max(254, "Destinatário muito longo."),
});
