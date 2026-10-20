// Retorno completo da deps podado para o input da IA (minimização de dados de terceiros).
// Só remove ruído, contato e dado pessoal que não alimenta o parecer; nunca muta o payload recebido.

import { extractMix } from "@/lib/deps/adapter";
import { DOCUMENT_KEYS, META_KEYS, isEnvelope, isRecord } from "@/lib/deps/payload-shape";
import { maskDocumentValue } from "@/lib/mask-document";
import type { Parecer } from "@/types/ai";

export const AI_BUREAU_MAX_CHARS = 80_000;
export const BUREAU_PROMPT_NOTE =
  "\n\nO campo `bureau` traz o retorno completo do bureau; use SCR, parecer Smart e renda presumida no plano de ação.";

export type BureauInput = Record<string, unknown> | null;
export interface CompanyBureaus { empresa: BureauInput; socios: BureauInput[] }
export interface PrunedBureau { bureau: BureauInput; removed: string[] }

// Decisão de produto: contato e dado pessoal que não alimenta o parecer não vai para a OpenAI.
const SKIPPED_MODULES: ReadonlySet<string> = new Set([...META_KEYS, "contatosPreferenciais", "emails", "outrosEnderecos"]);
const CONTACT_KEYS: ReadonlySet<string> = new Set(["telefone", "telefones", "email", "emails", "endereco", "enderecos", "cep"]);
const PESSOA_DROPPED_KEYS = ["nomeMae", "dataNascimento", "dadosCadastrais", "identidade"];

// Envelope vira o seu `data`; sem `data`, só a mensagem da deps (ou nada, se vazia).
function unwrap(value: unknown): unknown {
  if (!isEnvelope(value)) return value;
  if (value.data !== null && value.data !== undefined) return value.data;
  return typeof value.message === "string" && value.message.trim() ? { message: value.message } : undefined;
}

// Devolve cópia nova; `undefined` = descartar.
function scrub(value: unknown): unknown {
  const unwrapped = unwrap(value);
  if (Array.isArray(unwrapped)) return unwrapped.map(scrub).filter((item) => item !== undefined);
  if (!isRecord(unwrapped)) return unwrapped;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(unwrapped)) {
    if (CONTACT_KEYS.has(key)) continue;
    const cleaned = DOCUMENT_KEYS.has(key) ? maskDocumentValue(child) : scrub(child);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

function deleteKey(parent: unknown, key: string): boolean {
  return isRecord(parent) && delete parent[key];
}

// Remove `itensDetalhados` em qualquer profundidade do SCR (a maioria é null ou vazia fora do caminho de modalidades).
function dropDetailedItems(node: unknown): boolean {
  let removed = false;
  if (Array.isArray(node)) {
    for (const item of node) removed = dropDetailedItems(item) || removed;
  } else if (isRecord(node)) {
    if ("itensDetalhados" in node) removed = delete node.itensDetalhados;
    for (const child of Object.values(node)) removed = dropDetailedItems(child) || removed;
  }
  return removed;
}

// Ordem fixa da spec §3.6 (caminhos reais do payload desembrulhado): corta primeiro o que menos pesa no parecer.
const SIZE_CUTS: { path: string; cut: (bureau: Record<string, unknown>) => boolean }[] = [
  { path: "smart.historicoClassificacao", cut: (b) => deleteKey(b.smart, "historicoClassificacao") },
  { path: "smart.todasClassificacoes", cut: (b) => deleteKey(b.smart, "todasClassificacoes") },
  { path: "scr.vencimentoPorModalidade.vencimentoPorModalidades[].itens[].itensDetalhados", cut: (b) => dropDetailedItems(b.scr) },
];

function applySizeGuard(bureau: Record<string, unknown>): string[] {
  const removed: string[] = [];
  for (const step of SIZE_CUTS) {
    if (JSON.stringify(bureau).length <= AI_BUREAU_MAX_CHARS) break;
    if (step.cut(bureau)) removed.push(step.path);
  }
  return removed; // ainda acima do limite após os três cortes: segue assim (o contexto do modelo comporta).
}

export function pruneForAi(payload: unknown): PrunedBureau {
  const mix = extractMix(payload);
  const bureau: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(mix ?? {})) {
    if (SKIPPED_MODULES.has(key) || raw === null || raw === undefined) continue;
    const cleaned = scrub(raw);
    if (cleaned !== undefined) bureau[key] = cleaned;
  }
  if (Object.keys(bureau).length === 0) return { bureau: null, removed: [] };
  if (isRecord(bureau.pessoa)) {
    bureau.pessoa = Object.fromEntries(Object.entries(bureau.pessoa).filter(([key]) => !PESSOA_DROPPED_KEYS.includes(key)));
  }
  return { bureau, removed: applySizeGuard(bureau) };
}

// removed vazio → devolve o mesmo parecer; senão acrescenta uma linha em dados_faltantes (vai para ai_reports.full_report).
export function withRemovedNote(parecer: Parecer, removed: string[]): Parecer {
  if (removed.length === 0) return parecer;
  const note = `Dados retirados do input da IA por tamanho: ${removed.join(", ")}`;
  return { ...parecer, dados_faltantes: [...parecer.dados_faltantes, note] };
}

// Acrescenta `bureau` ao bloco de dados só quando há retorno podado.
export function withBureau<T extends object>(dados: T, bureau?: BureauInput): T | (T & { bureau: Record<string, unknown> }) {
  return bureau ? { ...dados, bureau } : dados;
}
