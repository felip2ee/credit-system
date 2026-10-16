// Cliente real da API DEPS Mix V3.
// Documentação: ./DEPARTAMENTO DE INTEGRAÇÕES.txt
// SOMENTE server-side — lê DEPS_API_EMAIL/PASSWORDL.

import type {
  ConsultOptions,
  DepsRawConsult,
  ScrAuthorizationCheck,
  ScrRequestInput,
  ScrRequestResult,
} from "@/types/deps";
import { DepsScrPendingError } from "./errors";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "./products";

export type { DepsRawConsult };

export interface RealDepsClient {
  readonly mode: "real";
  consultPF(cpf: string, options: ConsultOptions): Promise<DepsRawConsult>;
  consultPJ(cnpj: string, options: ConsultOptions): Promise<DepsRawConsult>;
  checkScrAuthorization(document: string): Promise<ScrAuthorizationCheck>;
  requestScrAuthorization(input: ScrRequestInput): Promise<ScrRequestResult>;
}

interface RealClientConfig {
  baseUrl: string;
  email: string;
  senha: string;
  centroCusto: string;
}

interface DepsProduto {
  identificador: string;
  nome: string;
  tipoPessoa: "F" | "J";
}

interface SessionCache {
  token: string;
  expiresAt: number;
  // nome do produto → identificador (retorno do login, `produtos[]`).
  produtoIds: Map<string, string>;
}

const onlyDigits = (s: string) => s.replace(/\D/g, "");

let session: SessionCache | null = null;

async function login(cfg: RealClientConfig): Promise<SessionCache> {
  const res = await fetch(`${cfg.baseUrl}/api/v3/conta/entrar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cfg.email, senha: cfg.senha }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Login deps falhou (${res.status}): ${txt.slice(0, 200)}`);
  }
  const json = (await res.json()) as unknown;
  // A resposta é um array [{...}].
  const payload = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
  if (!payload) throw new Error("Login deps: resposta vazia.");

  const token = payload.access_token as string | undefined;
  if (!token || typeof token !== "string") {
    throw new Error("Login deps: campo access_token ausente.");
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  // Renova 60s antes de expirar para evitar 401 em chamadas em voo.
  const expiresAt = Date.now() + (expiresIn - 60) * 1000;

  const produtos = (payload.produtos as DepsProduto[] | undefined) ?? [];
  const produtoIds = new Map(produtos.map((p) => [p.nome, p.identificador]));

  return { token, expiresAt, produtoIds };
}

async function getSession(cfg: RealClientConfig): Promise<SessionCache> {
  if (session && session.expiresAt > Date.now()) return session;
  session = await login(cfg);
  return session;
}

async function postWithAuth(
  cfg: RealClientConfig,
  url: string,
  body: Record<string, unknown>
): Promise<Response> {
  const exec = async (t: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t}`,
      },
      body: JSON.stringify(body),
    });

  let s = await getSession(cfg);
  let res = await exec(s.token);
  if (res.status === 401) {
    session = null;
    s = await getSession(cfg);
    res = await exec(s.token);
  }
  return res;
}

async function getProductId(cfg: RealClientConfig, nome: string): Promise<string> {
  const s = await getSession(cfg);
  const id = s.produtoIds.get(nome);
  if (!id) {
    throw new Error(`Produto "${nome}" não está disponível para esta conta na deps.`);
  }
  return id;
}

async function executeConsult(
  cfg: RealClientConfig,
  document: string,
  identificadorProduto: string,
  options: ConsultOptions
): Promise<{ httpStatus: number; body: unknown }> {
  // Body mínimo verificado em produção (n8n). `version` e `codigoCentroCustos`
  // são descritos como obrigatórios na doc mas a API aceita sem eles — só
  // enviamos quando explicitamente configurados.
  const body: Record<string, unknown> = {
    documento: document,
    identificadorProduto,
    // true = reaproveita dados existentes na deps (sem nova cobrança).
    reutilizarDadosExistentes: options.reuseExisting ?? true,
    // Gestão da autorização SCR (doc §4.2). Default true (autogestão):
    //   true  → NÓS gerimos o consentimento (termo + código por e-mail, ver
    //           actions/scr-self.ts); a deps cadastra a autorização no momento
    //           da consulta e não dispara o próprio e-mail.
    //   false → a deps verifica se já existe autorização registrada nela; se não
    //           houver, a consulta não é feita (retorna 400 → SCR pendente).
    autorizacaoScr: options.autorizacaoScr ?? true,
  };
  if (cfg.centroCusto && cfg.centroCusto.length > 0) {
    body.codigoCentroCustos = cfg.centroCusto;
  }

  const res = await postWithAuth(cfg, `${cfg.baseUrl}/api/v3/consultas/depsmix`, body);
  // Log apenas o status e flags — nunca o documento consultado nem o corpo da
  // resposta (dados pessoais). URLs/query params não são logados.
  console.log(
    "[deps] POST depsmix →",
    res.status,
    JSON.stringify({
      autorizacaoScr: body.autorizacaoScr,
      reutilizarDadosExistentes: body.reutilizarDadosExistentes,
    })
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // 400 = autorização SCR pendente / documento sem dados (doc §4.2). Tratado
    // como pendente pelo fluxo de consulta, não como falha.
    if (res.status === 400) {
      throw new DepsScrPendingError(
        `Autorização SCR pendente (400): ${txt.slice(0, 200)}`
      );
    }
    throw new Error(`Consulta deps falhou (${res.status}).`);
  }
  const json: unknown = await res.json().catch(() => null);
  return { httpStatus: res.status, body: json };
}

export function createRealDepsClient(cfg: RealClientConfig): RealDepsClient {
  return {
    mode: "real",
    async consultPF(cpf, options) {
      const document = onlyDigits(cpf);
      const produtoId = await getProductId(cfg, options.product);
      const { httpStatus, body } = await executeConsult(cfg, document, produtoId, options);
      return {
        httpStatus,
        product: options.product,
        body,
        receivedAt: new Date().toISOString(),
      };
    },
    async consultPJ(cnpj, options) {
      const document = onlyDigits(cnpj);
      const produtoId = await getProductId(cfg, options.product);
      const { httpStatus, body } = await executeConsult(cfg, document, produtoId, options);
      return {
        httpStatus,
        product: options.product,
        body,
        receivedAt: new Date().toISOString(),
      };
    },
    async checkScrAuthorization(document: string): Promise<ScrAuthorizationCheck> {
      // A deps não expõe consulta de status do SCR (doc §4.2). Status é mantido
      // localmente em `scr_authorizations`. Este método retorna pessimista; quem
      // consulta o fluxo de SCR deve usar nosso DB como fonte da verdade.
      return {
        document: onlyDigits(document),
        status: "not_authorized",
        authorizedAt: null,
        expiresAt: null,
        message: "Status SCR não disponível na API deps; verifique o registro local.",
      };
    },
    async requestScrAuthorization(input: ScrRequestInput): Promise<ScrRequestResult> {
      const document = onlyDigits(input.document);
      const identificadorProduto = await getProductId(cfg, input.type === "PF" ? DEPS_PRODUCT_PF : DEPS_PRODUCT_PJ);
      const body: Record<string, unknown> = {
        documento: document,
        identificadorProduto,
        autorizacaoScr: false,
        autorizacaoConsulta: {
          documento: document,
          nome: input.name ?? "",
          email: input.email ?? "",
        },
      };
      if (cfg.centroCusto && cfg.centroCusto.length > 0) {
        body.codigoCentroCustos = cfg.centroCusto;
      }
      const res = await postWithAuth(cfg, `${cfg.baseUrl}/api/v3/consultas/depsmix`, body);
      // A deps responde 200 ou 400 mas dispara o e-mail. Erros 401/5xx são reais.
      if (res.status !== 200 && res.status !== 400) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Solicitação SCR falhou (${res.status}): ${txt.slice(0, 200)}`);
      }
      return {
        document,
        status: "pending",
        requestedAt: new Date().toISOString(),
        message: "E-mail de autorização SCR disparado pela deps.",
      };
    },
  };
}
