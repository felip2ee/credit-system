// Ponto único de acesso ao bureau deps.com.br.
// SOMENTE server-side (Server Actions / Route Handlers / Edge Functions) —
// nunca importar em código client-side, pois lê credenciais.
//
// Exige DEPS_API_BASE_URL + DEPS_API_EMAIL + DEPS_API_PASSWORDL (DEPS Mix V3).
// Sem essas credenciais o client lança erro — não há mais fallback de mock.

import { createRealDepsClient } from "./real";
import type { DepsClient } from "@/types/deps";

export type {
  DepsClient,
  DepsConsultResult,
  DepsConsultResultPF,
  DepsConsultResultPJ,
  ScrAuthorizationCheck,
  ScrAuthorizationStatus,
} from "@/types/deps";

let cached: DepsClient | null = null;

export function getDepsClient(): DepsClient {
  if (cached) return cached;

  const baseUrl = process.env.DEPS_API_BASE_URL;
  const email = process.env.DEPS_API_EMAIL;
  const senha = process.env.DEPS_API_PASSWORDL ?? process.env.DEPS_API_PASSWORD;
  const centroCusto = process.env.DEPS_API_CENTRO_CUSTOS ?? "";
  const produtoPfNome = process.env.DEPS_PRODUTO_PF; // opcional, default "Smart PF 002"
  const produtoPjNome = process.env.DEPS_PRODUTO_PJ; // opcional, default "Smart PJ 010"

  if (!baseUrl || !email || !senha) {
    throw new Error(
      "Credenciais da deps ausentes: defina DEPS_API_BASE_URL, DEPS_API_EMAIL e DEPS_API_PASSWORDL."
    );
  }

  cached = createRealDepsClient({
    baseUrl,
    email,
    senha,
    centroCusto,
    produtoPfNome,
    produtoPjNome,
  });
  return cached;
}
