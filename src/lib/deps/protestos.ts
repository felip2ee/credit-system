// Leitura do bloco de protestos da deps.
//
// A deps devolve `protestos` como um OBJETO consolidado — não uma lista:
//   { quantidadeTotal, valorTotal, cartorios: [{ nome, uf, protestos: [{ data, valor }] }],
//     ultimasOcorrencias: [{ cartorio, uf, data, valor }], ... }
// O código antigo tipava isso como `Protesto[]` e contava com `.length`, que num
// objeto é `undefined` — e a tela mostrava "Nada consta" mesmo havendo protesto.
// Este módulo normaliza os dois formatos (objeto atual e lista legada).

export interface ProtestoOcorrencia {
  cartorio: string | null;
  uf: string | null;
  data: string | null;
  valor: number | null;
}

export interface ProtestosSummary {
  total: number;
  valorTotal: number | null;
  ocorrencias: ProtestoOcorrencia[];
}

const EMPTY: ProtestosSummary = { total: 0, valorTotal: null, ocorrencias: [] };

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function summarizeProtestos(data: unknown): ProtestosSummary {
  if (data == null) return EMPTY;

  // Formato legado: lista de protestos.
  if (Array.isArray(data)) {
    const ocorrencias = data.map((o) => {
      const r = (o ?? {}) as Record<string, unknown>;
      return {
        cartorio: str(r.cartorio),
        uf: str(r.uf),
        data: str(r.data),
        valor: num(r.valor),
      };
    });
    const soma = ocorrencias.reduce((acc, o) => acc + (o.valor ?? 0), 0);
    return { total: ocorrencias.length, valorTotal: soma || null, ocorrencias };
  }

  if (typeof data !== "object") return EMPTY;
  const d = data as Record<string, unknown>;

  // Ocorrências: preferimos as detalhadas dos cartórios; caímos em
  // ultimasOcorrencias quando o detalhe não vier.
  const ocorrencias: ProtestoOcorrencia[] = [];
  const cartorios = Array.isArray(d.cartorios) ? d.cartorios : [];
  for (const c of cartorios) {
    const cr = (c ?? {}) as Record<string, unknown>;
    const lista = Array.isArray(cr.protestos) ? cr.protestos : [];
    for (const p of lista) {
      const pr = (p ?? {}) as Record<string, unknown>;
      ocorrencias.push({
        cartorio: str(cr.nome),
        uf: str(cr.uf),
        data: str(pr.data),
        valor: num(pr.valor),
      });
    }
  }
  if (ocorrencias.length === 0 && Array.isArray(d.ultimasOcorrencias)) {
    for (const o of d.ultimasOcorrencias) {
      const r = (o ?? {}) as Record<string, unknown>;
      ocorrencias.push({
        cartorio: str(r.cartorio),
        uf: str(r.uf),
        data: str(r.data),
        valor: num(r.valor),
      });
    }
  }

  // quantidadeTotal é a fonte oficial; se vier nula, contamos o que der.
  const total = num(d.quantidadeTotal) ?? ocorrencias.length;
  const valorTotal =
    num(d.valorTotal) ??
    (ocorrencias.length > 0
      ? ocorrencias.reduce((acc, o) => acc + (o.valor ?? 0), 0) || null
      : null);

  return { total, valorTotal, ocorrencias };
}

export function countProtestos(data: unknown): number {
  return summarizeProtestos(data).total;
}
