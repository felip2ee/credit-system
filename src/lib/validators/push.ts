import { z } from "zod";

import { isAllowedPushEndpoint } from "@/lib/notifications/push-endpoint";

const INVALID = "Aparelho inválido. Tente ativar de novo.";
const REQUIRED = { required_error: INVALID, invalid_type_error: INVALID };

export const pushEndpointSchema = z.string(REQUIRED).refine(isAllowedPushEndpoint, INVALID);

// Formato de PushSubscription.toJSON(). Os padrões iguais aos CHECKs de push_subscriptions; campos extras
// (expirationTime) são descartados pelo z.object.
export const pushSubscriptionSchema = z.object({
	endpoint: pushEndpointSchema,
	keys: z.object(
		{
			p256dh: z.string(REQUIRED).regex(/^[A-Za-z0-9_-]{80,100}$/, INVALID),
			auth: z.string(REQUIRED).regex(/^[A-Za-z0-9_-]{16,32}$/, INVALID),
		},
		REQUIRED,
	),
});

export const pushEndpointInputSchema = z.object({ endpoint: pushEndpointSchema });
