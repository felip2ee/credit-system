// Cliente real da API DEPS Mix V3.
// Documentação: ./DEPARTAMENTO DE INTEGRAÇÕES.txt
// SOMENTE server-side — lê DEPS_API_EMAIL/PASSWORDL.

import type {
  ConsultOptions,
  DepsClient,
  DepsConsultResultPF,
  DepsConsultResultPJ,
  ScrAuthorizationCheck,
  ScrRequestInput,
  ScrRequestResult,
} from "@/types/deps";
import { DepsScrPendingError } from "./errors";
import { DEPS_PRODUCT_PF, DEPS_PRODUCT_PJ } from "./products";

interface RealClientConfig {
  baseUrl: string;
  email: string;
  senha: string;
  centroCusto: string;
  // Nome dos produtos a usar (default: Smart PF 002 / Smart PJ 010).
  // Os IDs vêm do retorno do login (campo `produtos[].identificador`).
  produtoPfNome?: string;
  produtoPjNome?: string;
}

interface DepsProduto {
  identificador: string;
  nome: string;
  tipoPessoa: "F" | "J";
}

interface SessionCache {
  token: string;
  expiresAt: number;
  produtoIdPF: string | null;
  produtoIdPJ: string | null;
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
  const nomePF = cfg.produtoPfNome ?? DEPS_PRODUCT_PF;
  const nomePJ = cfg.produtoPjNome ?? DEPS_PRODUCT_PJ;
  const produtoIdPF = produtos.find((p) => p.nome === nomePF)?.identificador ?? null;
  const produtoIdPJ = produtos.find((p) => p.nome === nomePJ)?.identificador ?? null;

  return { token, expiresAt, produtoIdPF, produtoIdPJ };
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

async function getProductId(
  cfg: RealClientConfig,
  tipo: "PF" | "PJ"
): Promise<string> {
  const s = await getSession(cfg);
  const id = tipo === "PF" ? s.produtoIdPF : s.produtoIdPJ;
  if (!id) {
    const nome = tipo === "PF" ? (cfg.produtoPfNome ?? DEPS_PRODUCT_PF) : (cfg.produtoPjNome ?? DEPS_PRODUCT_PJ);
    throw new Error(`Produto "${nome}" não está disponível para esta conta na deps.`);
  }
  return id;
}

function extractMix(json: unknown): Record<string, unknown> | null {
  if (
    Array.isArray(json) &&
    json.length > 0 &&
    typeof json[0] === "object" &&
    json[0] !== null &&
    "mix" in json[0]
  ) {
    return (json[0] as { mix: Record<string, unknown> }).mix;
  }
  if (typeof json === "object" && json !== null && "mix" in json) {
    return (json as { mix: Record<string, unknown> }).mix;
  }
  return null;
}

function buildEnvelopePF(document: string, mix: Record<string, unknown>): DepsConsultResultPF {
  return {
    historicoConsultaId:
      (mix.historicoConsultaId as string | undefined) ?? crypto.randomUUID(),
    type: "PF",
    document,
    consultedAt: (mix.dataConsulta as string | undefined) ?? new Date().toISOString(),
    apiVersion: typeof mix.versao === "number" ? (mix.versao as number) : 2,
    productVersion: (mix.produto as string | undefined) ?? DEPS_PRODUCT_PF,
    isPartial: (mix.isParcial as boolean | undefined) ?? false,
    shareLink: (mix.linkCompartilhamento as string | null | undefined) ?? null,
    mix: mix as unknown as DepsConsultResultPF["mix"],
    raw: mix,
  };
}

function buildEnvelopePJ(document: string, mix: Record<string, unknown>): DepsConsultResultPJ {
  return {
    historicoConsultaId:
      (mix.historicoConsultaId as string | undefined) ?? crypto.randomUUID(),
    type: "PJ",
    document,
    consultedAt: (mix.dataConsulta as string | undefined) ?? new Date().toISOString(),
    apiVersion: typeof mix.versao === "number" ? (mix.versao as number) : 2,
    productVersion: (mix.produto as string | undefined) ?? DEPS_PRODUCT_PJ,
    isPartial: (mix.isParcial as boolean | undefined) ?? false,
    shareLink: (mix.linkCompartilhamento as string | null | undefined) ?? null,
    mix: mix as unknown as DepsConsultResultPJ["mix"],
    raw: mix,
  };
}

async function executeConsult(
  cfg: RealClientConfig,
  document: string,
  identificadorProduto: string,
  options?: ConsultOptions
): Promise<Record<string, unknown>> {
  // Body mínimo verificado em produção (n8n). `version` e `codigoCentroCustos`
  // são descritos como obrigatórios na doc mas a API aceita sem eles — só
  // enviamos quando explicitamente configurados.
  const body: Record<string, unknown> = {
    documento: document,
    identificadorProduto,
    // true = reaproveita dados existentes na deps (sem nova cobrança).
    reutilizarDadosExistentes: options?.reuseExisting ?? true,
    // Gestão da autorização SCR (doc §4.2). Default true (autogestão):
    //   true  → NÓS gerimos o consentimento (termo + código por e-mail, ver
    //           actions/scr-self.ts); a deps cadastra a autorização no momento
    //           da consulta e não dispara o próprio e-mail.
    //   false → a deps verifica se já existe autorização registrada nela; se não
    //           houver, a consulta não é feita (retorna 400 → SCR pendente).
    autorizacaoScr: options?.autorizacaoScr ?? true,
  };
  if (cfg.centroCusto && cfg.centroCusto.length > 0) {
    body.codigoCentroCustos = cfg.centroCusto;
  }

  const res = await postWithAuth(cfg, `${cfg.baseUrl}/api/v3/consultas/depsmix`, body);
  // DIAGNÓSTICO temporário — enviado à deps (documento + flags).
  console.log(
    "[deps] POST depsmix →",
    res.status,
    JSON.stringify({
      documento: document,
      autorizacaoScr: body.autorizacaoScr,
      reutilizarDadosExistentes: body.reutilizarDadosExistentes,
    })
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // DIAGNÓSTICO temporário — corpo do erro (400 = SCR pendente / sem dados).
    console.log("[deps] resposta não-OK:", res.status, txt.slice(0, 500));
    // 400 = autorização SCR pendente / documento sem dados (doc §4.2). Tratado
    // como pendente pelo fluxo de consulta, não como falha.
    if (res.status === 400) {
      throw new DepsScrPendingError(
        `Autorização SCR pendente (400): ${txt.slice(0, 200)}`
      );
    }
    throw new Error(`Consulta deps falhou (${res.status}): ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const mix = extractMix(json);
  // DIAGNÓSTICO temporário — mapa de preenchimento de TODOS os blocos do mix,
  // para levantar quais vêm vazios por tipo/perfil (PF/PJ, PEP, sem histórico).
  if (!mix) {
    console.log(
      "[deps] 200 SEM `mix`. Chaves de topo:",
      JSON.stringify(json).slice(0, 800)
    );
  } else {
    // Classifica cada bloco: "cheio" | "vazio" (null / data null / array vazio).
    const fill: Record<string, string> = {};
    for (const [k, v] of Object.entries(mix as Record<string, unknown>)) {
      if (v == null) {
        fill[k] = "vazio";
      } else if (Array.isArray(v)) {
        fill[k] = v.length > 0 ? `cheio[${v.length}]` : "vazio[]";
      } else if (typeof v === "object" && "data" in (v as object)) {
        const d = (v as { data?: unknown }).data;
        fill[k] =
          d == null || (Array.isArray(d) && d.length === 0) ? "vazio" : "cheio";
      } else {
        fill[k] = "cheio";
      }
    }
    console.log(
      "[deps] 200 mapa de blocos:",
      JSON.stringify({ documento: document, blocos: fill })
    );
  }
  if (!mix) throw new Error("Resposta da deps não contém `mix`.");
  return mix;
}

export function createRealDepsClient(cfg: RealClientConfig): DepsClient {
  return {
    mode: "real",
    async consultPF(cpf, options) {
      const document = onlyDigits(cpf);
      const produtoId = await getProductId(cfg, "PF");
      const mix = await executeConsult(cfg, document, produtoId, options);
      return buildEnvelopePF(document, mix);
    },
    async consultPJ(cnpj, options) {
      const document = onlyDigits(cnpj);
      const produtoId = await getProductId(cfg, "PJ");
      const mix = await executeConsult(cfg, document, produtoId, options);
      return buildEnvelopePJ(document, mix);
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
      const identificadorProduto = await getProductId(cfg, input.type);
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
