// Ponto único de acesso ao Asaas. SOMENTE server-side. O driver vem de ASAAS_DRIVER; sem ele falha (sem fallback).
import { readAsaasConfig } from "@/lib/config";

import { createAsaasClient } from "./client";
import { createFakeAsaasClient } from "./fake";
import type { AsaasClient } from "./types";

export { AsaasHttpError, AsaasOutcomeUnknownError, CardDeclinedError } from "./client";
export type {
	AsaasClient,
	AsaasCustomerInput,
	CardChargeInput,
	CardChargeResult,
	PixChargeInput,
	PixChargeResult,
} from "./types";

export function getAsaasClient(): AsaasClient {
	const settings = readAsaasConfig(process.env);
	return settings.driver === "fake" ? createFakeAsaasClient() : createAsaasClient(settings);
}
