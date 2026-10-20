# Consulta completa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The staff screen, the portal screen, the three PDFs and the AI opinion show 100% of the raw deps payload (`bureau_payloads.payload`), with known cards first and a generic renderer for every other module, without a change to the adapter or to `CanonicalBureauResult`.

**Architecture:** A pure view-model (`toFullConsultationView`) turns the latest raw payload of a consultation into ordered typed sections plus generic blocks, a missing list and footer metadata, all as display-ready strings. One React renderer and one `@react-pdf/renderer` renderer draw that same tree, so screen and PDF show the same content in the same order. The AI receives a pruned copy (`pruneForAi`: envelopes unwrapped, documents masked, contact data and footer removed, size guard), and the portal reads the payload through a new RLS policy that mirrors `bureau_results_client_released`.

**Tech Stack:** Next.js 14.2 App Router (Server Components), React 18, TypeScript strict, shadcn/ui, `@react-pdf/renderer` 4, `pg` raw SQL under RLS, Vitest 4 (node env), OpenAI SDK 6.

**Spec:** docs/superpowers/specs/2026-10-19-consulta-completa-design.md

## Global Constraints

- No new dependency. `@react-pdf/renderer`, React, `react-dom/server` and zod already exist.
- TypeScript files ≤ 350 lines. New files must stay under that limit; split by responsibility.
- Existing over-limit files must not grow: `src/lib/pdf/consultation-document.tsx` (492), `src/lib/pdf/consultation-full-document.tsx` (464), `src/lib/ai/prompt.ts` (539), `src/lib/deps/adapter.ts` (457), `src/lib/db/rls.integration.test.ts` (2313, may grow by at most the lines of one new count key). Adding the `export` keyword is allowed; adding lines is not.
- `src/lib/deps/adapter.ts`: only change is `export` on `extractMix` (line 96), required by spec §3.1. No behavior change. `src/types/bureau.ts`, `src/lib/consultations/service.ts`, `ADAPTER_VERSION`: untouched.
- UI strings, error messages and code comments in pt-BR. Identifiers in English. Imports with `@/`.
- Migration file: `db/migrations/024_bureau_payloads_client_released.sql`. Never edit an applied migration (001–023). No `begin`/`commit` in the file (the runner wraps it).
- Every query runs inside `withUserTransaction`. No `PoolClient` leaves a queries module.
- No audit event: the feature is read-only.
- Never log the payload, a document or a model response. No new `console` calls.
- `cpf`, `cnpj`, `documento` (exact key, any depth) never appear unmasked on screen, PDF or AI input. Mask rule: `maskDocumentValue` (Task 1), same output as SQL `order_mask_document` (`***.456.789-**`, `**.345.678/0001-**`).
- Fixture `src/lib/deps/__fixtures__/smart-pf-002.json` never contains a real CPF, name, phone, e-mail or address.
- Data source for content: the latest `bureau_payloads` row of the consultation (`order by received_at desc limit 1`), never `bureau_results.payload_id`. `canonical_result` stays for lists, score/risk and the fallback.
- Implementers do not commit. The coordinator runs the `git add` / `git commit` of each task, in task order.
- After each task that changes code: `graphify update .`.
- Commands: `npm run test`, `npm run type-check`, `npm run lint`, `npm run db:migrate`. One file: `npx vitest run <path>`. Integration tests need Postgres at `127.0.0.1:54329`: `docker compose -f docker-compose.dev.yml up -d`.

## Review Focus

Failure modes the spec implies but does not test. Each one has a test in the owning task.

1. **Address leak to OpenAI through `pessoa.data.dadosCadastrais`.** The real payload has a home address (`uf, cep, bairro, cidade, numero, endereco, complemento`) inside `pessoa.data.dadosCadastrais`, which the spec's AI removal list does not name. Test in Task 4: `pruneForAi(fixture).bureau.pessoa` has no `dadosCadastrais`, no `identidade`, no `nomeMae`, no `dataNascimento`.
2. **Payload present but useless, or payload without canonical.** The integration seed stores `'{}'::jsonb` as payload; `payload_incompatible` consultations have a payload and no `bureau_results`. A naive switch shows a blank screen in the first case and skips the member in the PDF (`if (!m.canonical) continue`) in the second. Tests: Task 2 `toConsultationContent({}, canonical)` falls back to the canonical view; Task 6 portal route renders a member that has `payload` and `canonical: null`.
3. **Inner keys dropped by a typed card.** A typed card picks named keys; a new key inside `scr.data` or `smart.data.parecer` would vanish with no error (anti-goal "chave sem destino"). Test in Task 2: inject `scr.data.campoNovo` and `smart.data.parecer.campoNovo`; both appear in the section under "Outros campos".
4. **A deps error message hidden as "Sem informação".** An envelope with `data: null` and a message such as "Erro ao consultar o bloco" is not the same as "Sem informação." / "Nada consta.". Test in Task 1 (`isMissingModule`) and Task 2 (block lands in `generic` with that text, not in `missing`).
5. **Timestamp shifted by timezone.** deps strings like `"2026-10-19T14:30:00"` have no zone; converting them through `Date` on a UTC server shifts the hour. Test in Task 2: zone-less ISO renders the literal digits (`19/10/2026 14:30`), only `Z`/offset strings go through `formatDateTime`.

## File Structure

```
src/lib/deps/__fixtures__/smart-pf-002.json      (new, Task 1) anonymized real Smart PF 002 payload
src/lib/deps/payload-shape.ts                    (new, Task 1) isRecord, isEnvelope, isMissingModule, META_KEYS, DOCUMENT_KEYS
src/lib/mask-document.ts                         (moved from src/components/dossiers/, Task 1) + maskDocumentValue
src/types/consultation-view.ts                   (new, Task 2) FullConsultationView contract
src/lib/consultations/labels.ts                  (new, Task 2) labelFor
src/lib/consultations/generic-block.ts           (new, Task 2) formatScalar, toGenericValue, toGenericBlock
src/lib/consultations/full-view-sections.ts      (new, Task 2) typed section builders
src/lib/consultations/full-view.ts               (new, Task 2) toFullConsultationView, toConsultationContent
db/migrations/024_bureau_payloads_client_released.sql (new, Task 3)
src/lib/ai/bureau-input.ts                       (new, Task 4) pruneForAi, withRemovedNote, BUREAU_PROMPT_NOTE
src/components/consultations/generic-block.tsx   (new, Task 5) GenericValueView
src/components/consultations/full-consultation-result.tsx (new, Task 5)
src/lib/pdf/generic-block.tsx                    (new, Task 6) PdfGenericValue
src/lib/pdf/complete-consultation-document.tsx   (new, Task 6) CompleteConsultationPage, ConsultationPdfPage, renderCompleteConsultationPdf
```

---

### Task 1: Fixture and shared payload primitives

Agent: `backend-specialist`, model `sonnet`. Wave 1.

**Files:**
- Create: `src/lib/deps/__fixtures__/smart-pf-002.json`
- Create: `src/lib/deps/payload-shape.ts`, Test: `src/lib/deps/payload-shape.test.ts`
- Move: `src/components/dossiers/mask-document.ts` → `src/lib/mask-document.ts` (`git mv`), Test: `src/lib/mask-document.test.ts`
- Modify: `src/app/(dashboard)/dossiers/page.tsx:13` (import path only)
- Modify: `src/lib/deps/adapter.ts:96` (`function extractMix` → `export function extractMix`; no other change)

**Depends-on:** none

**Interfaces:**
- Produces (`src/lib/deps/payload-shape.ts`):
  ```ts
  export interface ModuleEnvelope { success: unknown; message: unknown; data: unknown; info?: unknown }
  export const isRecord: (value: unknown) => value is Record<string, unknown>;
  // Envelope = registro com "success" e "data" e nenhuma chave fora de {success, message, data, info}.
  export function isEnvelope(value: unknown): value is ModuleEnvelope;
  // true para null, undefined, ou envelope com data null e message nula/vazia/"Sem informação."/"Nada consta." (sem diferenciar maiúsculas, ponto opcional).
  export function isMissingModule(value: unknown): boolean;
  // Rodapé, spec §3.2 item 11 (chaves de mix), na ordem da spec.
  export const META_KEYS: readonly string[] = ["versao", "produto", "dataConsulta", "consultante", "usuario", "historicoConsultaId", "isParcial", "isGrupo", "centroCusto", "blocosComErros", "linkCompartilhamento"];
  export const DOCUMENT_KEYS: ReadonlySet<string> = new Set(["cpf", "cnpj", "documento"]);
  ```
- Produces (`src/lib/mask-document.ts`): existing `maskDocument(type: EntityKind, document: string): string` (moved) plus
  ```ts
  // Valor bruto do payload (string ou número). 11 dígitos → máscara de CPF, 14 → CNPJ, outro → "—". Nunca devolve o número completo.
  export function maskDocumentValue(value: unknown): string;
  ```
- Produces: `extractMix(body: unknown): Record<string, unknown> | null` exported from `@/lib/deps/adapter`.

**Rules:** 06-security, 05-testing, typescript/coding-standards, 03-coding-principles (smallest change; the move fixes a Dependency Rule break: `src/lib` must not import from `src/components`).

- [ ] Step: generate the fixture with this one-off inline script (not committed). Run from the repo root with Postgres up. It replaces only personal values, keeps every key, type, number and array length, and fails if any replaced original value survives.

```bash
docker compose -f docker-compose.dev.yml exec -T postgres psql -U postgres -d credit_system -t -A \
  -c "select payload from bureau_payloads where consultation_id='97ff10ca-d271-434d-a6e6-cddcfcc48ad1'" \
| node -e '
const fs = require("node:fs");
const p = JSON.parse(fs.readFileSync(0, "utf8"));
const m = p.mix;
const originals = [];
const swap = (obj, key, fake) => {
  if (!obj || obj[key] === null || obj[key] === undefined || obj[key] === "") return;
  originals.push(String(obj[key]));
  obj[key] = typeof fake === "function" ? fake(obj[key]) : fake;
};
const FAKE_CPF = "52998224725";
const fakeDate = (v) => String(v).replace(/\d{4}-\d{2}-\d{2}/, "1980-01-01").replace(/\d{2}\/\d{2}\/\d{4}/, "01/01/1980");
const address = (a) => { swap(a, "endereco", "Rua Exemplo"); swap(a, "numero", "100"); swap(a, "cep", "01001000"); swap(a, "complemento", "Casa"); };
const pd = m.pessoa.data;
swap(pd, "nome", "Maria Exemplo da Silva");
swap(pd, "cpf", (v) => (typeof v === "number" ? Number(FAKE_CPF) : FAKE_CPF));
swap(pd, "dataNascimento", fakeDate);
swap(pd, "nomeMae", "Mae Exemplo da Silva");
swap(pd, "identidade", "000000000");
swap(pd, "codigoControleReceita", (v) => String(v).replace(/[0-9A-Za-z]/g, "0"));
address(pd.dadosCadastrais);
m.emails.data = m.emails.data.map((e, i) => { originals.push(String(e)); return `titular${i + 1}@example.com`; });
for (const c of m.contatosPreferenciais.data) {
  swap(c, "telefone", (v) => String(v).replace(/\d/g, "9"));
  swap(c, "nome", "Contato Exemplo");
  swap(c, "rua", "Rua Exemplo");
  swap(c, "numero", "100");
  swap(c, "documento", FAKE_CPF);
}
for (const a of m.outrosEnderecos.data) address(a);
swap(m, "usuario", "usuario-teste");
swap(m, "consultante", "Consultante Teste");
swap(m, "historicoConsultaId", "historico-teste-0");
swap(m, "linkCompartilhamento", "https://example.com/compartilhamento/teste");
(m.smart?.data?.historicoClassificacao ?? []).forEach((h, i) => swap(h, "historicoConsultaId", `historico-teste-${i + 1}`));
const out = JSON.stringify(p, null, 2) + "\n";
const leaked = originals.filter((o) => o.length >= 4 && out.includes(o));
if (leaked.length) { console.error(`falhou: ${leaked.length} valor(es) original(is) ainda no arquivo`); process.exit(1); }
fs.writeFileSync("src/lib/deps/__fixtures__/smart-pf-002.json", out);
console.error("ok");
'
```

- [ ] Step: write failing tests.

`src/lib/mask-document.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { maskDocument, maskDocumentValue } from "./mask-document";

describe("maskDocument", () => {
  it("masks a CPF like order_mask_document", () => {
    expect(maskDocument("PF", "52998224725")).toBe("***.982.247-**");
  });
  it("masks a CNPJ like order_mask_document", () => {
    expect(maskDocument("PJ", "11222333000181")).toBe("**.222.333/0001-**");
  });
  it("returns a dash for a wrong length", () => {
    expect(maskDocument("PF", "123")).toBe("—");
  });
});

describe("maskDocumentValue", () => {
  it.each([
    ["52998224725", "***.982.247-**"],
    [52998224725, "***.982.247-**"],
    ["529.982.247-25", "***.982.247-**"],
    ["11222333000181", "**.222.333/0001-**"],
    ["123", "—"],
    [null, "—"],
    [{ a: 1 }, "—"],
  ])("maskDocumentValue(%j) is %s", (input, expected) => {
    expect(maskDocumentValue(input)).toBe(expected);
  });
});
```
Note: the current CPF branch returns `***.982.247-***` (three trailing stars). The first test fails until the regex replaces the last two digits with `**`.

`src/lib/deps/payload-shape.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isEnvelope, isMissingModule } from "./payload-shape";
import fixture from "./__fixtures__/smart-pf-002.json";

describe("isEnvelope", () => {
  it("accepts a deps module envelope", () => {
    expect(isEnvelope({ success: true, message: null, data: { a: 1 }, info: null })).toBe(true);
    expect(isEnvelope({ success: true, message: "Nada consta.", data: null })).toBe(true);
  });
  it("rejects objects with other keys or without success/data", () => {
    expect(isEnvelope({ success: true, data: 1, codigo: 2 })).toBe(false);
    expect(isEnvelope({ data: 1 })).toBe(false);
    expect(isEnvelope([])).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });
});

describe("isMissingModule", () => {
  it.each([
    [null, true],
    [{ success: true, message: "Sem informação.", data: null }, true],
    [{ success: true, message: "nada consta", data: null }, true],
    [{ success: true, message: null, data: null }, true],
    [{ success: false, message: "Erro ao consultar o bloco", data: null }, false],
    [{ success: true, message: null, data: { a: 1 } }, false],
  ])("isMissingModule(%j) is %s", (input, expected) => {
    expect(isMissingModule(input)).toBe(expected);
  });
});

describe("smart-pf-002 fixture", () => {
  it("holds only fake personal data", () => {
    const m = fixture.mix;
    expect(String(m.pessoa.data.cpf)).toBe("52998224725");
    expect(m.pessoa.data.nome).toBe("Maria Exemplo da Silva");
    expect(m.emails.data.every((e: string) => e.endsWith("@example.com"))).toBe(true);
    expect(m.contatosPreferenciais.data.every((c: { documento: unknown }) => c.documento == null || c.documento === "52998224725")).toBe(true);
    expect(m.usuario).toBe("usuario-teste");
    expect(m.consultante).toBe("Consultante Teste");
  });
});
```

- [ ] Step: run `npx vitest run src/lib/mask-document.test.ts src/lib/deps/payload-shape.test.ts`, expected FAIL (modules missing; CPF mask has 3 trailing stars).
- [ ] Step: implement. `git mv src/components/dossiers/mask-document.ts src/lib/mask-document.ts`; fix the CPF replace to end in `-**`; add `maskDocumentValue` (`onlyDigits(String(value))` for string/number, else "—"; dispatch to `maskDocument` by length). Update the import at `src/app/(dashboard)/dossiers/page.tsx:13` to `@/lib/mask-document`. Write `payload-shape.ts` per the interface. Add `export` to `extractMix` in `adapter.ts:96`.
- [ ] Step: run `npx vitest run src/lib/mask-document.test.ts src/lib/deps/payload-shape.test.ts src/lib/deps/adapter.test.ts && npm run type-check`, expected PASS. `wc -l src/lib/deps/adapter.ts` = 457.
- [ ] Step: commit.
```bash
git add src/lib/deps/__fixtures__/smart-pf-002.json src/lib/deps/payload-shape.ts src/lib/deps/payload-shape.test.ts \
  src/lib/mask-document.ts src/lib/mask-document.test.ts src/components/dossiers/mask-document.ts \
  "src/app/(dashboard)/dossiers/page.tsx" src/lib/deps/adapter.ts
git commit -m "feat(deps): fixture anonimizada Smart PF 002, forma do payload e máscara de documento em lib"
```

---

### Task 2: Full view-model and generic renderer rules

Agent: `backend-specialist`, model `sonnet`. Wave 2.

**Files:**
- Create: `src/types/consultation-view.ts`
- Create: `src/lib/consultations/labels.ts`
- Create: `src/lib/consultations/generic-block.ts`, Test: `src/lib/consultations/generic-block.test.ts`
- Create: `src/lib/consultations/full-view-sections.ts`
- Create: `src/lib/consultations/full-view.ts`, Test: `src/lib/consultations/full-view.test.ts`

**Depends-on:** 1

**Interfaces:**
- Consumes: `extractMix` (`@/lib/deps/adapter`); `isRecord`, `isEnvelope`, `isMissingModule`, `META_KEYS`, `DOCUMENT_KEYS` (`@/lib/deps/payload-shape`); `maskDocumentValue` (`@/lib/mask-document`); `formatCurrency`, `formatDateTime` (`@/lib/utils`); `toConsultationView`, `ConsultationView` (`@/lib/consultations/view-model`); `CanonicalBureauResult` (`@/types/bureau`).
- Produces — contract, exact (`src/types/consultation-view.ts`):
  ```ts
  export type GenericValue =
    | { kind: "text"; text: string }
    | { kind: "fields"; fields: GenericField[] }
    | { kind: "table"; columns: { key: string; label: string }[]; rows: string[][] }
    | { kind: "json"; text: string };

  export interface GenericField { key: string; label: string; value: GenericValue }

  export interface GenericBlock { key: string; title: string; note: string | null; value: GenericValue }

  export interface SectionPart { title: string | null; value: GenericValue; collapsed: boolean }

  export type FullSectionId = "score" | "smart" | "scr" | "rendaPresumida" | "restricoes" | "pessoa" | "contatos" | "consultas";

  // sources = chaves de `mix` consumidas pela seção (prova de que nenhuma chave fica sem destino).
  export interface FullSection { id: FullSectionId; title: string; sources: string[]; parts: SectionPart[] }

  export interface FullConsultationView {
    sections: FullSection[];               // itens 1-8 da spec §3.2, na ordem, só os presentes
    generic: GenericBlock[];               // item 9, na ordem do payload
    missing: { key: string; label: string }[]; // item 10
    meta: GenericField[];                  // item 11 (META_KEYS + chaves da raiz fora de mix)
    scoreValue: number | null;             // barra de score do PDF
  }
  ```
- Produces (`labels.ts`): `export function labelFor(key: string): string`.
- Produces (`generic-block.ts`):
  ```ts
  export function formatScalar(key: string, value: unknown): string;
  export function toGenericValue(value: unknown, key?: string, depth?: number): GenericValue;
  export function toGenericBlock(key: string, moduleValue: unknown): GenericBlock;
  ```
- Produces (`full-view.ts`):
  ```ts
  export const FULL_SECTION_TITLES: Record<FullSectionId, string> = {
    score: "Score", smart: "Parecer Smart", scr: "SCR (Banco Central)", rendaPresumida: "Renda presumida",
    restricoes: "Restrições", pessoa: "Pessoa", contatos: "Contatos e endereços", consultas: "Consultas",
  };
  export const FULL_DATA_UNAVAILABLE = "Dados completos não disponíveis.";
  // null quando o payload não tem mix utilizável (null, não-objeto, ou mix sem chaves, ex. '{}').
  export function toFullConsultationView(payload: unknown): FullConsultationView | null;
  export interface ConsultationContent { full: FullConsultationView | null; view: ConsultationView | null }
  export function toConsultationContent(payload: unknown, canonical: CanonicalBureauResult | null): ConsultationContent;
  ```
- Produces (`full-view-sections.ts`): one builder per typed section, `(mix: Record<string, unknown>) => FullSection | null`, consumed only by `full-view.ts`.

**Rules:** 05-testing, 06-security, 01-ddd (pure, no DB), typescript/coding-standards (narrow `unknown` with guards, no `as` on payload data), 03-coding-principles.

**Generic renderer rules (spec §3.3, exact):**

| Input | Output |
|---|---|
| Envelope (`isEnvelope`) at any depth | Render `data`. `data` null → `text` = `message` (or "—"). `toGenericBlock`: `info` not null → `note` (`formatScalar("info", info)`, objects as JSON). |
| Object, depth ≤ 4 | `fields`, one per key in key order, label `labelFor(key)`. Nested object → nested `fields`. Module `data` root is depth 1. |
| Object or array at depth > 4 | `json`, `JSON.stringify(maskDeep(value), null, 2)` |
| Array, every element a record | `table`; columns = union of keys in first-occurrence order; cell = `formatScalar(column, cell)`; missing cell "—"; object/array cell → compact JSON of the masked value |
| Array of primitives | `text`, items formatted and joined with ", " |
| Empty array | `text` "Nenhum" |
| Mixed array / array of arrays | `json` (masked) |
| Key in `DOCUMENT_KEYS` | `maskDocumentValue(value)`; `null` → "—". Checked before any other rule. |
| `null` / `undefined` | "—" |
| boolean | "Sim" / "Não" |
| number, key matches `/valor\|total\|limite\|ticket\|renda\|gasto/i` | `formatCurrency(value)` (values are reais) |
| other number | `new Intl.NumberFormat("pt-BR").format(value)` |
| string `^\d{4}-\d{2}-\d{2}$` or `...T00:00:00(.000)?` without zone | `dd/mm/aaaa`, sliced from the string (no `Date`) |
| string ISO with time, no zone | `dd/mm/aaaa hh:mm`, sliced from the string (no `Date`) |
| string ISO with `Z` or `±hh:mm` | `formatDateTime(value)` (São Paulo) |
| other string (includes "10,22%") | as is |
| Label | `labelFor`: dictionary first (`scr`→"SCR", `cpf`→"CPF", `cnpj`→"CNPJ", `uf`→"UF", `cep`→"CEP", `pep`→"PEP", `prejuizo`→"Prejuízo", `coobrigacao`→"Coobrigação", `creditoLiberar`→"Crédito a liberar", `balanco`→"Balanço", `informacaoConsulta`→"Informações da consulta"); else split camelCase, lowercase, capitalize first letter ("rendaPresumida" → "Renda presumida") |

**Typed sections (spec §3.2, real paths in the payload):** each builder picks named keys and appends one part titled "Outros campos" with `toGenericValue(rest)` for every non-picked key of each picked object (`smart.data`, `smart.data.parecer`, `smart.data.classificacao`, `scr.data`, `scr.data.vencimentoPorModalidade`, `scr.data.vencimentosConsolidados`, `score.data`, `rendaPresumida.data`, `pessoa.data`), when the rest is not empty.
- `score` (sources `["score"]`): fields `score, risco, descricao, scoreBoleto, probabilidadePagamento, descricaoPagamento`. `scoreValue` = `score.data.score` when number.
- `smart` (`["smart"]`): parts "Parecer" (fields `aprovado, motivo`), "Resultado do parecer" (table `nome, atendido, percentual, percentualEsperado`), "Classificação" (fields `classificacao, limiteSugerido, porte, politica, validade, ticketMedio, pontuacaoAtingida`), "Métricas positivas" / "Métricas negativas" (table `metrica, descricao, pontuacao, impacto, percentualMetrica`), "Todas as classificações" and "Histórico de classificação" (generic tables, `collapsed: true`).
- `scr` (`["scr"]`): "Totais" (table Descrição/Valor/Percentual, one row per `vencimentoPorModalidade.{carteiraAtiva, carteiraCredito, riscoTotal, riscoAssumido, riscoIndireto, responsabilidadeTotal, coobrigacaoRecebida}`); "A vencer" and "Vencidos" (`vencimentosConsolidados.itensAVencer|itensVencidos`: rows `descricao, valor, percentual`, last row `descricaoTotal, valorTotal, percentualTotal`); one part per `vencimentoPorModalidade.vencimentoPorModalidades[]` titled by its `descricaoTotal`, each `itens[]` row followed by its `itensDetalhados[]` rows with the description prefixed "  — "; one part per group `prejuizo, coobrigacao, limiteCredito, creditoLiberar, repasseInterfinanceiro` (same table shape, title `labelFor`); "Informações da consulta" (fields from `vencimentosConsolidados.informacaoConsulta[]`, label = `descricao`, value = `valor`).
- `rendaPresumida` (`["rendaPresumida"]`): fields `valor, valorMinimo, valorMaximo, rendaPresumida, gastoEstimado, possuiGastoEstimado`, plus `pessoa.data.rendaPresumida` and `pessoa.data.mensagemErroRendaPresumida` when not null/empty.
- `restricoes` (`["pendenciasRestricoes", "protestos", "acoesJudiciais", "restricoesCheques"]`, the ones present): one part per module, title `labelFor`; `data` not null → `toGenericValue(data)`; else `text` = `message` or "Nada consta.". Present when at least one of the four keys exists.
- `pessoa` (`["pessoa"]`): fields of `pessoa.data` minus `rendaPresumida` and `mensagemErroRendaPresumida` (`cpf` masked, `dadosCadastrais` nested).
- `contatos` (`contatosPreferenciais, emails, outrosEnderecos` present with content): one part each, generic value.
- `consultas` (`["consultas"]`): fields of `consultas.data`.
- A typed section whose module is `isMissingModule` is not built; its key goes to `missing` (except the four `restricoes` keys).
- `generic`: every other `mix` key not in `META_KEYS`, in payload order, that is not `isMissingModule` → `toGenericBlock(key, value)`. Non-object scalars too.
- `missing`: keys where `isMissingModule` is true and no section consumed them, `{ key, label: labelFor(key) }`.
- `meta`: `META_KEYS` present in `mix` (in that order), then root keys outside `mix` (e.g. `consultasComplementares`), each `{ key, label, value: toGenericValue(v, key) }`.
- `toConsultationContent`: `full = toFullConsultationView(payload)`; `view = canonical ? toConsultationView(canonical) : null`.

- [ ] Step: write failing tests (fixture = `import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json"`; canonical via `adapt(fixture, ctx)` as in `view-model.test.ts:11-21`).

`src/lib/consultations/generic-block.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { formatScalar, toGenericBlock, toGenericValue } from "./generic-block";
import { labelFor } from "./labels";

describe("labelFor", () => {
  it.each([["rendaPresumida", "Renda presumida"], ["scr", "SCR"], ["cpf", "CPF"], ["uf", "UF"], ["vencimentoPorModalidades", "Vencimento por modalidades"]])(
    "%s → %s", (key, label) => expect(labelFor(key)).toBe(label));
});

describe("formatScalar", () => {
  it.each([
    ["valorTotal", 1234.5, formatCurrency(1234.5)],
    ["limiteSugerido", 5000, formatCurrency(5000)],
    ["pontuacaoAtingida", 1234.5, "1.234,5"],
    ["possuiGastoEstimado", true, "Sim"],
    ["obito", false, "Não"],
    ["motivos", null, "—"],
    ["percentual", "10,22%", "10,22%"],
    ["dataNascimento", "1980-01-01T00:00:00", "01/01/1980"],
    ["dataConsulta", "2026-10-19", "19/10/2026"],
    ["dataHora", "2026-10-19T14:30:00", "19/10/2026 14:30"],
    ["dataHoraReceita", "2026-10-19T17:30:00Z", formatDateTime("2026-10-19T17:30:00Z")],
    ["cpf", "52998224725", "***.982.247-**"],
    ["cpf", 52998224725, "***.982.247-**"],
    ["cnpj", "11222333000181", "**.222.333/0001-**"],
    ["documento", "123", "—"],
  ])("formatScalar(%s, %j) is %s", (key, value, expected) => expect(formatScalar(key, value)).toBe(expected));
});

describe("toGenericValue", () => {
  it("unwraps an envelope and keeps info as note", () => {
    const block = toGenericBlock("modNovo", { success: true, message: null, data: { a: 1 }, info: "nota" });
    expect(block).toEqual({ key: "modNovo", title: "Mod novo", note: "nota", value: { kind: "fields", fields: [{ key: "a", label: "A", value: { kind: "text", text: "1" } }] } });
  });
  it("shows the message of an envelope without data", () => {
    expect(toGenericValue({ success: true, message: "Nada consta.", data: null })).toEqual({ kind: "text", text: "Nada consta." });
  });
  it("turns an array of objects into a table with the union of keys", () => {
    expect(toGenericValue([{ a: 1 }, { b: 2, a: 3 }])).toEqual({
      kind: "table",
      columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      rows: [["1", "—"], ["3", "2"]],
    });
  });
  it("masks a document column inside a table", () => {
    const v = toGenericValue([{ documento: "52998224725", nome: "X" }]);
    expect(v).toMatchObject({ kind: "table", rows: [["***.982.247-**", "X"]] });
  });
  it("joins primitives and says Nenhum for an empty array", () => {
    expect(toGenericValue(["a", "b"])).toEqual({ kind: "text", text: "a, b" });
    expect(toGenericValue([])).toEqual({ kind: "text", text: "Nenhum" });
  });
  it("falls back to masked JSON beyond depth 4", () => {
    const deep = { n1: { n2: { n3: { n4: { n5: { cpf: "52998224725" } } } } } };
    const text = JSON.stringify(toGenericValue(deep));
    expect(text).toContain('"kind":"json"');
    expect(text).not.toContain("52998224725");
  });
  it("masks a nested cpf at any depth", () => {
    expect(JSON.stringify(toGenericValue({ a: { b: { cpf: "52998224725" } } }))).not.toContain("52998224725");
  });
});
```

`src/lib/consultations/full-view.test.ts`:
```ts
// helpers: const mix = (fixture as { mix: Record<string, unknown> }).mix; clone = structuredClone(fixture)
it("orders the typed sections like spec §3.2", () => {
  const v = toFullConsultationView(fixture)!;
  expect(v.sections.map((s) => s.title)).toEqual(["Score", "Parecer Smart", "SCR (Banco Central)", "Renda presumida", "Restrições", "Pessoa", "Contatos e endereços", "Consultas"]);
  expect(v.scoreValue).toBe(fixture.mix.score.data.score);
});
it("gives every mix key a destination", () => {
  const v = toFullConsultationView(fixture)!;
  const dest = new Set([...v.sections.flatMap((s) => s.sources), ...v.generic.map((g) => g.key), ...v.missing.map((m) => m.key), ...v.meta.map((f) => f.key)]);
  expect(Object.keys(fixture.mix).filter((k) => !dest.has(k))).toEqual([]);
  expect(dest.has("consultasComplementares")).toBe(true);
});
it("lists null modules as missing and keeps footer keys out of it", () => {
  const keys = toFullConsultationView(fixture)!.missing.map((m) => m.key);
  expect(keys).toEqual(expect.arrayContaining(["balanco", "empresa", "quadroSocietario", "participacaoEmpresa", "depsIa"]));
  expect(keys).not.toContain("centroCusto"); // rodapé
  expect(keys).not.toContain("protestos"); // consumido por Restrições
});
it("fills the Smart card with collapsed history parts", () => {
  const smart = toFullConsultationView(fixture)!.sections.find((s) => s.id === "smart")!;
  const titles = smart.parts.map((p) => p.title);
  expect(titles).toEqual(expect.arrayContaining(["Parecer", "Resultado do parecer", "Classificação", "Métricas positivas", "Métricas negativas", "Todas as classificações", "Histórico de classificação"]));
  expect(smart.parts.filter((p) => p.collapsed).map((p) => p.title)).toEqual(["Todas as classificações", "Histórico de classificação"]);
});
it("fills the SCR card with the seven totals and the groups", () => {
  const scr = toFullConsultationView(fixture)!.sections.find((s) => s.id === "scr")!;
  const totals = scr.parts.find((p) => p.title === "Totais")!.value;
  expect(totals.kind === "table" && totals.rows.length).toBe(7);
  expect(scr.parts.map((p) => p.title)).toEqual(expect.arrayContaining(["A vencer", "Vencidos", "Prejuízo", "Coobrigação", "Limite de crédito", "Crédito a liberar", "Repasse interfinanceiro", "Informações da consulta"]));
});
it("shows restrictions with the deps message when there is no data", () => {
  const r = toFullConsultationView(fixture)!.sections.find((s) => s.id === "restricoes")!;
  expect(r.parts.find((p) => p.title === "Protestos")!.value).toEqual({ kind: "text", text: "Nada consta." });
});
it("never shows the full CPF", () => {
  const v = toFullConsultationView(fixture)!;
  expect(JSON.stringify(v)).not.toContain("52998224725");
});
it("keeps unknown keys inside typed cards under Outros campos", () => {      // Review Focus 3
  const c = structuredClone(fixture) as any;
  c.mix.scr.data.campoNovo = 123;
  c.mix.smart.data.parecer.campoNovo = "x";
  const v = toFullConsultationView(c)!;
  for (const id of ["scr", "smart"] as const) {
    expect(JSON.stringify(v.sections.find((s) => s.id === id)!.parts)).toContain("Campo novo");
  }
});
it("renders a new deps module through the generic block", () => {
  const c = structuredClone(fixture) as any;
  c.mix.modNovo = { success: true, message: null, data: { valorTotal: 10 }, info: null };
  expect(toFullConsultationView(c)!.generic.map((g) => g.key)).toEqual(["modNovo"]);
});
it("keeps a deps error message out of the missing list", () => {          // Review Focus 4
  const c = structuredClone(fixture) as any;
  c.mix.balanco = { success: false, message: "Erro ao consultar o bloco", data: null, info: null };
  const v = toFullConsultationView(c)!;
  expect(v.missing.map((m) => m.key)).not.toContain("balanco");
  expect(v.generic.find((g) => g.key === "balanco")!.value).toEqual({ kind: "text", text: "Erro ao consultar o bloco" });
});
it("accepts [{mix}], {mix} and the bare mix", () => {
  expect(toFullConsultationView([fixture])!.sections).toHaveLength(8);
  expect(toFullConsultationView(fixture.mix)!.sections).toHaveLength(8);
});
describe("toConsultationContent", () => {                                    // Review Focus 2
  it("uses the payload when it has a mix", () => {
    const c = toConsultationContent(fixture, canonical(fixture));
    expect(c.full).not.toBeNull();
    expect(c.view).not.toBeNull();
  });
  it("falls back to the canonical view for an empty payload", () => {
    const c = toConsultationContent({}, canonical(fixture));
    expect(c.full).toBeNull();
    expect(c.view?.subject.name).toBe("Maria Exemplo da Silva");
  });
  it("returns nothing when both are absent", () => {
    expect(toConsultationContent(null, null)).toEqual({ full: null, view: null });
  });
});
```

- [ ] Step: run `npx vitest run src/lib/consultations/generic-block.test.ts src/lib/consultations/full-view.test.ts`, expected FAIL (modules missing).
- [ ] Step: implement `labels.ts`, `generic-block.ts` (one recursive `toGenericValue(value, key, depth = 1)` plus a `maskDeep` helper for JSON fallbacks), `full-view-sections.ts` (builders + a `pickWithRest(obj, keys)` helper that returns `{ picked, rest }`), `full-view.ts` (root extras via `Array.isArray(payload) ? payload[0] : payload`, mix via `extractMix`). Each file ≤ 350 lines.
- [ ] Step: run `npx vitest run src/lib/consultations && npm run type-check && npm run lint`, expected PASS.
- [ ] Step: commit.
```bash
git add src/types/consultation-view.ts src/lib/consultations/labels.ts src/lib/consultations/generic-block.ts \
  src/lib/consultations/generic-block.test.ts src/lib/consultations/full-view-sections.ts \
  src/lib/consultations/full-view.ts src/lib/consultations/full-view.test.ts
git commit -m "feat(consultations): view-model completo do payload da deps com renderizador genérico"
```

---

### Task 3: Client RLS on bureau_payloads and payload queries

Agent: `database-architect`, model `sonnet`. Wave 1.

**Files:**
- Create: `db/migrations/024_bureau_payloads_client_released.sql`
- Modify: `src/lib/db/rls.integration.test.ts:2185-2224` (tests "client reads delivery only while released" and "client reads zero third party holders, payloads, scr rows and costs")
- Modify: `src/lib/consultations/canonical-store.ts` (append `loadLatestPayload` after line 23)
- Modify: `src/lib/orders/client-queries.ts:84-97` (type), `:112-142` (members query and map)
- Modify: `src/lib/orders/client-queries.integration.test.ts:219-226`
- Modify: `src/lib/dossiers/queries.ts:263-280` (`dossierCanonicalResults`)
- Modify: `docs/architecture.md:86-89` (migrations 001–024 + one bullet for 024), `:106-114` (one decision row)

**Depends-on:** none

**Interfaces:**
- Produces:
  ```ts
  // canonical-store.ts — payload bruto mais recente da consulta, sob RLS; null se não houver (purgado ou nunca recebido).
  export async function loadLatestPayload(identity: DbIdentity, consultationId: string): Promise<unknown>;
  // client-queries.ts — ClientDelivery.members[number] ganha:
  payload: unknown; // null quando não há linha em bureau_payloads
  // dossiers/queries.ts — dossierCanonicalResults passa a devolver:
  Promise<{ type: EntityKind; canonical_result: CanonicalBureauResult; payload: unknown }[]>
  ```

**Rules:** db/migrations conventions (024, no begin/commit, intent comment), 06-security (least privilege, cross-tenant), 05-testing (new policy needs a case in `rls.integration.test.ts`), typescript/coding-standards.

- [ ] Step: write failing tests.

`src/lib/db/rls.integration.test.ts`, inside `describe("orders and delivery (022)")`:
```ts
// "client reads delivery only while released": add to the returned object of `deliveries`
payloads: await count("select count(*) as n from bureau_payloads where consultation_id = $1", rows.consultation),
// and to the expectations
const none = { dossiers: 0, consultations: 0, results: 0, reports: 0, payloads: 0 };
const all = { dossiers: 1, consultations: 1, results: 1, reports: 1, payloads: 1 };
// This one test already proves the three spec §3.7 cases: own released reads (all),
// own not released reads none, other client of the same Bureau reads none, client of another Bureau reads none.

// "client reads zero third party holders, payloads, scr rows and costs" → rename to
// "client reads zero third party holders, other payloads, scr rows and costs" and replace line 2218 with:
expect(await countAs(ctxOf(T.client),
  "select count(*) as n from bureau_payloads where consultation_id not in (select id from consultations where dossier_id = $1)",
  [ownOrder])).toBe(0);
```

`src/lib/orders/client-queries.integration.test.ts:224`:
```ts
members: [{ type: "PF", status: "completed", canonical: { marker: "canonical" }, payload: {}, opinion: null }],
```
(`seedResult` already inserts `'{}'::jsonb` as the payload.)

- [ ] Step: run `docker compose -f docker-compose.dev.yml up -d && npx vitest run src/lib/db/rls.integration.test.ts src/lib/orders/client-queries.integration.test.ts`, expected FAIL (`payloads: 0` for the released client; `payload` missing in the delivery).
- [ ] Step: implement the migration, exact:
```sql
-- Portal do cliente (spec 2026-10-19 consulta completa): o cliente lê o payload bruto da deps só de pedido próprio em
-- 'released'. Espelho de bureau_results_client_released (022), com a junção em bureau_payloads.consultation_id.
-- Substitui a decisão D23 da 022 ("sem política de cliente em bureau_payloads"). app_runtime já tem select (004).
drop policy if exists bureau_payloads_client_released on bureau_payloads;
create policy bureau_payloads_client_released on bureau_payloads for select
  using (app_context_present() and app_user_role() = 'client' and bureau_id = app_bureau_id()
         and exists (select 1 from consultations c join dossier_orders o on o.dossier_id = c.dossier_id
                      where c.id = bureau_payloads.consultation_id
                        and o.client_profile_id = app_user_id() and o.state = 'released'));
```
- [ ] Step: implement the queries. `loadLatestPayload`: `select payload from bureau_payloads where consultation_id = $1 order by received_at desc limit 1`, inside `withUserTransaction`, returns `rows[0]?.payload ?? null`. `getMyDelivery` members query: add `p.payload` to the select list and
```sql
left join lateral (
  select bp.payload from bureau_payloads bp
   where bp.consultation_id = c.id
   order by bp.received_at desc limit 1
) p on true
```
and map `payload: m.payload ?? null`. `dossierCanonicalResults`: same lateral join, add `p.payload` to the select and the row type. The existing unique index `(consultation_id, payload_sha256)` covers the lookup; no new index.
- [ ] Step: update `docs/architecture.md`: line 86 "de `001` a `024`"; new bullet "A 024 dá ao cliente leitura de `bureau_payloads` só de pedido próprio em `released` (`bureau_payloads_client_released`)."; new row in Decisões: "Tela, PDF e IA leem o payload bruto (`bureau_payloads`), não o canônico | Mostrar 100% do retorno da deps sem deploy por módulo novo (spec 2026-10-19). | Payload ultrapassar o limite de tamanho da tela ou do PDF."
- [ ] Step: run `npm run db:migrate && npx vitest run src/lib/db/rls.integration.test.ts src/lib/orders/client-queries.integration.test.ts && npm run type-check`, expected PASS.
- [ ] Step: commit.
```bash
git add db/migrations/024_bureau_payloads_client_released.sql src/lib/db/rls.integration.test.ts \
  src/lib/consultations/canonical-store.ts src/lib/orders/client-queries.ts \
  src/lib/orders/client-queries.integration.test.ts src/lib/dossiers/queries.ts docs/architecture.md
git commit -m "feat(db): RLS do cliente em bureau_payloads e leitura do payload mais recente"
```

---

### Task 4: AI input with the pruned payload

Agent: `backend-specialist`, model `sonnet`. Wave 2.

**Files:**
- Create: `src/lib/ai/bureau-input.ts`, Test: `src/lib/ai/bureau-input.test.ts`
- Modify: `src/lib/ai/prompt.ts:9` (version), `:63`, `:115`, `:397` (`${RAINHA_RULES}` → `${RAINHA_RULES}${BUREAU_PROMPT_NOTE}`), `:275-279` (rewrite the now false allow-list comment in 2 lines), `:365-383` (`ParecerInput`, `buildUserPayload`), `:391` (version), `:491-513` (`CompanyParecerInput`, `buildCompanyPayload`). Net line delta ≤ 0 (539 today).
- Modify: `src/lib/ai/opinion.ts:98-113`
- Modify: `src/lib/ai/parecer-prompt.md` (same paragraph as `BUREAU_PROMPT_NOTE`, next to the `dados_bureau` example at line ~168)
- Modify: `src/actions/ai.ts:30-34`, Test: `src/actions/ai.test.ts:13` (add `loadLatestPayload` to the mock)
- Modify: `src/actions/dossiers.ts:35-46`
- Modify: `src/lib/orders/ai.ts:6,20-23,40-47`, Test: `src/lib/orders/ai.test.ts:10,20,35,45,65-80`

**Depends-on:** 1, 3

**Interfaces:**
- Consumes: `extractMix` (`@/lib/deps/adapter`), `isRecord`, `isEnvelope`, `META_KEYS`, `DOCUMENT_KEYS` (`@/lib/deps/payload-shape`), `maskDocumentValue` (`@/lib/mask-document`), `loadLatestPayload` (`@/lib/consultations/canonical-store`), `dossierCanonicalResults(...)[].payload` (Task 3).
- Produces (`bureau-input.ts`):
  ```ts
  export const AI_BUREAU_MAX_CHARS = 80_000;
  export const BUREAU_PROMPT_NOTE =
    "\n\nO campo `bureau` traz o retorno completo do bureau; use SCR, parecer Smart e renda presumida no plano de ação.";
  export interface PrunedBureau { bureau: Record<string, unknown> | null; removed: string[] }
  export function pruneForAi(payload: unknown): PrunedBureau;
  // removed vazio → devolve o mesmo parecer; senão acrescenta uma linha em dados_faltantes (vai para ai_reports.full_report).
  export function withRemovedNote(parecer: Parecer, removed: string[]): Parecer;
  ```
- Produces (`prompt.ts`):
  ```ts
  export const PROMPT_VERSION = "parecer-v2";
  export const COMPANY_PROMPT_VERSION = "parecer-empresa-v3";
  export interface ParecerInput { type: "PF" | "PJ"; dataAnalise: string; canonical: CanonicalBureauResult; payload?: unknown }
  export function buildUserPayload(input: ParecerInput, bureau?: Record<string, unknown> | null): string; // adds "bureau" key only when not null
  export interface CompanyParecerInput {
    dataAnalise: string;
    empresaRow: Record<string, unknown>;
    empresaPayload?: unknown;
    socios: { type: "PF" | "PJ"; resultRow: Record<string, unknown>; payload?: unknown }[];
  }
  export function buildCompanyPayload(
    input: CompanyParecerInput,
    bureaus?: { empresa: Record<string, unknown> | null; socios: (Record<string, unknown> | null)[] },
  ): string; // dados_empresa.bureau and dados_socios[i].bureau when not null
  ```
- Produces (`opinion.ts`): `generateParecer` prunes `input.payload`, calls `buildUserPayload(input, pruned.bureau)`, returns `{ parecer: withRemovedNote(parecer, pruned.removed), model }`. `generateCompanyParecer` prunes `empresaPayload` and each `socios[i].payload`; removed paths are prefixed `empresa.` and `socio{i+1}.`.

**Rules:** 06-security (third-party data minimization, no payload in logs), 05-testing (builders tested, OpenAI faked or not called), typescript/coding-standards, `src/lib/ai/CLAUDE.md` (do not grow `prompt.ts`; bump versions on prompt change).

**`pruneForAi` steps, in this order:**
1. `mix = extractMix(payload)`; null or no keys → `{ bureau: null, removed: [] }`.
2. For each `mix` key: skip `META_KEYS`; skip `contatosPreferenciais`, `emails`, `outrosEnderecos`; `null` → skip; envelope with `data` null → `{ message }` when message is a non-empty string, else skip; envelope → its `data`; other values as is.
3. Deep transform of the kept values (new objects, no input mutation): unwrap nested envelopes the same way; key in `DOCUMENT_KEYS` → `maskDocumentValue`; drop keys `telefone`, `telefones`, `email`, `emails`, `endereco`, `enderecos`, `cep` at any depth (PJ contact equivalents, spec §3.7).
4. Delete `pessoa.nomeMae`, `pessoa.dataNascimento` (spec §3.7), `pessoa.dadosCadastrais` (home address, Review Focus 1), `pessoa.identidade` (identity document number).
5. Size guard, exact form:
```ts
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
```
`deleteKey` and `dropDetailedItems` return `true` only when they removed something. They mutate the copy built in steps 2–4, never the input.

- [ ] Step: write failing tests in `src/lib/ai/bureau-input.test.ts` (fixture from Task 1; `pad(n)` builds `n` copies of the first element of an array):
```ts
it("unwraps envelopes and keeps the deps message of data-less modules", () => {
  const { bureau } = pruneForAi(fixture);
  expect(bureau!.score).toEqual(fixture.mix.score.data);
  expect(bureau!.protestos).toEqual({ message: "Nada consta." });
});
it("drops null modules and footer keys", () => {
  const b = pruneForAi(fixture).bureau!;
  expect(b).not.toHaveProperty("balanco");
  for (const k of ["versao", "produto", "dataConsulta", "consultante", "usuario", "historicoConsultaId", "isParcial", "isGrupo", "centroCusto", "blocosComErros", "linkCompartilhamento"]) {
    expect(b).not.toHaveProperty(k);
  }
});
it("drops contact and personal data that does not feed the opinion", () => {          // Review Focus 1
  const b = pruneForAi(fixture).bureau!;
  for (const k of ["contatosPreferenciais", "emails", "outrosEnderecos"]) expect(b).not.toHaveProperty(k);
  for (const k of ["nomeMae", "dataNascimento", "dadosCadastrais", "identidade"]) expect(b.pessoa).not.toHaveProperty(k);
});
it("masks documents at any depth", () => {
  const { bureau } = pruneForAi(fixture);
  expect((bureau!.pessoa as Record<string, unknown>).cpf).toBe("***.982.247-**");
  expect(JSON.stringify(bureau)).not.toContain("52998224725");
});
it("drops PJ contact keys at any depth", () => {
  const c = structuredClone(fixture) as any;
  c.mix.empresa = { success: true, message: null, info: null, data: { razaoSocial: "X", telefones: ["11999999999"], endereco: "Rua", cep: "01001000", cnpj: "11222333000181" } };
  expect(pruneForAi(c).bureau!.empresa).toEqual({ razaoSocial: "X", cnpj: "**.222.333/0001-**" });
});
it("does not cut a payload under the limit", () => {
  expect(pruneForAi(fixture).removed).toEqual([]);
});
it("cuts history first, then all classifications, then detailed SCR items", () => {
  const c = structuredClone(fixture) as any;
  c.mix.smart.data.historicoClassificacao = pad(c.mix.smart.data.historicoClassificacao, 400);
  let r = pruneForAi(c);
  expect(r.removed).toEqual(["smart.historicoClassificacao"]);
  expect((r.bureau!.smart as Record<string, unknown>).todasClassificacoes).toBeDefined();
  expect(JSON.stringify(r.bureau).length).toBeLessThanOrEqual(80_000);

  c.mix.smart.data.todasClassificacoes = pad(c.mix.smart.data.todasClassificacoes, 600);
  r = pruneForAi(c);
  expect(r.removed).toEqual(["smart.historicoClassificacao", "smart.todasClassificacoes"]);

  const mods = c.mix.scr.data.vencimentoPorModalidade.vencimentoPorModalidades;
  mods[0].itens[0].itensDetalhados = pad(mods[0].itens[0].itensDetalhados, 1500);
  r = pruneForAi(c);
  expect(r.removed).toEqual(["smart.historicoClassificacao", "smart.todasClassificacoes", "scr.vencimentoPorModalidade.vencimentoPorModalidades[].itens[].itensDetalhados"]);
  expect(JSON.stringify(r.bureau)).not.toContain("itensDetalhados");
});
it("returns no bureau for a missing or empty payload", () => {
  expect(pruneForAi(null)).toEqual({ bureau: null, removed: [] });
  expect(pruneForAi({})).toEqual({ bureau: null, removed: [] });
});
it("adds bureau to the user payload only when present", () => {
  const input = { type: "PF" as const, dataAnalise: "2026-10-19", canonical: canonical(fixture) };
  expect(JSON.parse(buildUserPayload(input, { score: { score: 1 } })).bureau).toEqual({ score: { score: 1 } });
  expect(JSON.parse(buildUserPayload(input))).not.toHaveProperty("bureau");
});
it("records cut keys in dados_faltantes", () => {
  const parecer = { dados_faltantes: ["x"] } as unknown as Parecer;
  expect(withRemovedNote(parecer, [])).toBe(parecer);
  expect(withRemovedNote(parecer, ["smart.historicoClassificacao"]).dados_faltantes).toEqual(["x", "Dados retirados do input da IA por tamanho: smart.historicoClassificacao"]);
});
it("bumps the prompt versions and tells the model about bureau", () => {
  expect(PROMPT_VERSION).toBe("parecer-v2");
  expect(COMPANY_PROMPT_VERSION).toBe("parecer-empresa-v3");
  for (const p of [SYSTEM_PROMPT_PF, SYSTEM_PROMPT_PJ, COMPANY_SYSTEM_PROMPT]) expect(p).toContain("O campo `bureau` traz o retorno completo do bureau");
});
```
Adjust the `pad` counts only if a step does not cross 80 000 characters; the assertions stay.

Update `src/lib/orders/ai.test.ts`: add `loadLatestPayload: vi.fn()` to the hoisted state and to the `canonical-store` mock (line 20); `s.loadLatestPayload.mockResolvedValue({ bruto: true })` (line 35); line 45 expects `{ type: "PF", dataAnalise: expect.any(String), canonical: { canonico: true }, payload: { bruto: true } }`; lines 65-80 rows gain `payload: { p: n }` and the expectation gains `empresaPayload: { p: 1 }` and `payload` per sócio. Update `src/actions/ai.test.ts:13` mock: `loadLatestPayload: vi.fn(async () => null)`.

- [ ] Step: run `npx vitest run src/lib/ai/bureau-input.test.ts src/lib/orders/ai.test.ts src/actions/ai.test.ts`, expected FAIL.
- [ ] Step: implement `bureau-input.ts`, the `prompt.ts` and `opinion.ts` changes per the interfaces, and pass the payload in the three callers: `src/actions/ai.ts` (`payload: await loadLatestPayload(identity, queryId)`), `src/lib/orders/ai.ts` (`payload: await loadLatestPayload(identity, main.consultationId)`; group: `empresaPayload: company.payload`, `payload: row.payload` per sócio), `src/actions/dossiers.ts` (same as the group path). `src/actions/dossiers.test.ts` needs no change (it mocks `dossierCanonicalResults` and `generateCompanyParecer`).
- [ ] Step: run `npx vitest run src/lib/ai src/lib/orders/ai.test.ts src/actions && npm run type-check && npm run lint && wc -l src/lib/ai/prompt.ts`, expected PASS and ≤ 539 lines.
- [ ] Step: commit.
```bash
git add src/lib/ai/bureau-input.ts src/lib/ai/bureau-input.test.ts src/lib/ai/prompt.ts src/lib/ai/opinion.ts \
  src/lib/ai/parecer-prompt.md src/actions/ai.ts src/actions/ai.test.ts src/actions/dossiers.ts \
  src/lib/orders/ai.ts src/lib/orders/ai.test.ts
git commit -m "feat(ai): parecer recebe o payload completo da deps podado (parecer-v2, parecer-empresa-v3)"
```

---

### Task 5: Staff and portal screens

Agent: `frontend-specialist`, model `sonnet`. Wave 3. Invoke `/vercel:shadcn` and `/ui-ux-pro-max` before the layout work.

**Files:**
- Create: `src/components/consultations/generic-block.tsx`
- Create: `src/components/consultations/full-consultation-result.tsx`, Test: `src/components/consultations/full-consultation-result.test.ts`
- Modify: `src/app/(dashboard)/consultations/[id]/page.tsx:20-27` (imports), `:43-53` (load), `:118-126` (render)
- Modify: `src/components/orders/delivery-view.tsx:3,8,61-65`

**Depends-on:** 2, 3

**Interfaces:**
- Consumes: `FullConsultationView`, `GenericValue`, `GenericBlock` (`@/types/consultation-view`); `toConsultationContent`, `FULL_DATA_UNAVAILABLE` (`@/lib/consultations/full-view`); `loadLatestPayload`, `loadCanonicalResult` (`@/lib/consultations/canonical-store`); `ClientDelivery.members[number].payload` (Task 3); existing `ConsultationResult`, `ConsultationUnavailable`, `incompatibleView`; shadcn `Card*`, `Table*` (`@/components/ui/table`).
- Produces:
  ```ts
  export function GenericValueView({ value }: { value: GenericValue }): JSX.Element;          // generic-block.tsx, recursive, server component
  export function FullConsultationResult({ view }: { view: FullConsultationView }): JSX.Element; // full-consultation-result.tsx, server component
  ```

**Rules:** react/coding-standards (named exports, stable keys from `key`/index only for static rows), next/coding-standards (Server Components, no `"use client"`), 06-security (no unmasked document), 05-testing (one render test for conditional rendering), components CLAUDE.md (shadcn primitives, pt-BR text).

Render rules: one `Card` per `view.sections` item in order (title = `section.title`; Score card shows `scoreValue` large); each part: `title` as subheading, `collapsed: true` → `<details>` with `<summary>` = part title (pattern of `delivery-view.tsx:32-37`); `fields` → `dl` grid; `table` → shadcn `Table` inside `overflow-x-auto`; `json` → `pre` with `whitespace-pre-wrap`; `text` → `p`. Then a Card "Outros dados da deps" with one sub-block per `generic` item (title, note in muted text), only when not empty. Then one line "Sem informação: " + `missing` labels joined with ", ", only when not empty. Then a small muted footer "Dados da consulta" with `meta`.

Page logic (staff): for `completed` or `payload_incompatible`, `content = toConsultationContent(await loadLatestPayload(session, query.id), await loadCanonicalResult(session, query.id))`; render `content.full` → `<FullConsultationResult view={content.full} />`; else `content.view` → `<p className="text-sm text-muted-foreground">{FULL_DATA_UNAVAILABLE}</p>` + `<ConsultationResult view={content.view} />`; else `<ConsultationUnavailable {...incompatibleView(query.id)} />` (props `consultationId`, `message`). Delivery view: same three branches per member with `toConsultationContent(m.payload, m.canonical)`; the third branch keeps the current "Resultado indisponível para esta consulta." message. The portal page file needs no change.

- [ ] Step: write failing test `src/components/consultations/full-consultation-result.test.ts` (no JSX in `.test.ts`: use `createElement`):
```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { toFullConsultationView } from "@/lib/consultations/full-view";
import { FullConsultationResult } from "./full-consultation-result";

describe("FullConsultationResult", () => {
  const html = renderToStaticMarkup(createElement(FullConsultationResult, { view: toFullConsultationView(fixture)! }));
  it("shows the known cards", () => {
    for (const t of ["Parecer Smart", "SCR (Banco Central)", "Renda presumida", "Contatos e endereços"]) expect(html).toContain(t);
  });
  it("collapses the Smart history and lists missing modules", () => {
    expect(html).toContain("<details");
    expect(html).toContain("Sem informação:");
  });
  it("never renders the full CPF", () => {
    expect(html).not.toContain("52998224725");
    expect(html).not.toContain("529.982.247-25");
  });
});
```
- [ ] Step: run `npx vitest run src/components/consultations/full-consultation-result.test.ts`, expected FAIL.
- [ ] Step: implement the two components, the page change and the delivery view change. Each new file ≤ 350 lines.
- [ ] Step: run `npx vitest run src/components/consultations && npm run type-check && npm run lint`, expected PASS.
- [ ] Step: commit.
```bash
git add src/components/consultations/generic-block.tsx src/components/consultations/full-consultation-result.tsx \
  src/components/consultations/full-consultation-result.test.ts "src/app/(dashboard)/consultations/[id]/page.tsx" \
  src/components/orders/delivery-view.tsx
git commit -m "feat(consultations): tela da consulta e do portal mostram o retorno completo da deps"
```

---

### Task 6: PDFs (consultation, dossier, portal)

Agent: `frontend-specialist`, model `sonnet`. Wave 3.

**Files:**
- Create: `src/lib/pdf/generic-block.tsx`
- Create: `src/lib/pdf/complete-consultation-document.tsx`, Test: `src/lib/pdf/complete-consultation-document.test.ts`
- Modify: `src/lib/pdf/consultation-full-document.tsx:109,143,151,172` (add `export` to `ScoreBar`, `Section`, `Field`, `Table`; line count stays 464)
- Modify: `src/lib/pdf/dossier-document.tsx:9,17-22,42-49`
- Modify: `src/app/(dashboard)/consultations/[id]/pdf/route.ts:3-8,48-57,79-96`
- Modify: `src/app/(dashboard)/dossiers/[id]/pdf/route.ts:4-8,50-67`
- Modify: `src/app/(portal)/portal/pesquisas/[id]/pdf/route.ts:2,53-67`, Test: `src/app/(portal)/portal/pesquisas/[id]/pdf/route.test.ts:27-30,45-49` (+ new cases)

**Depends-on:** 2, 3

**Interfaces:**
- Consumes: `FullConsultationView`, `GenericValue` (`@/types/consultation-view`); `toConsultationContent`, `FULL_DATA_UNAVAILABLE`, `ConsultationContent` (`@/lib/consultations/full-view`); `loadLatestPayload` (Task 3); `Bg`, `pdfStyles`, `FullConsultationPage`, `FullPdfHeader`, `ScoreBar`, `Section`, `Field`, `Table` (`./consultation-full-document`); `OpinionBlock`, `OpinionForPdf` (`./markdown-pdf`); `formatCPF`, `formatCNPJ` (`@/lib/utils`).
- Produces:
  ```ts
  // generic-block.tsx
  export function PdfGenericValue({ value }: { value: GenericValue }): JSX.Element;
  // complete-consultation-document.tsx
  export interface CompleteConsultationPageProps { full: FullConsultationView; header: FullPdfHeader; letterhead: string; opinion?: OpinionForPdf | null }
  export function CompleteConsultationPage(props: CompleteConsultationPageProps): JSX.Element;
  // full presente → CompleteConsultationPage; senão view → FullConsultationPage com a nota; senão null.
  export function ConsultationPdfPage(props: ConsultationContent & { header: FullPdfHeader; letterhead: string; opinion?: OpinionForPdf | null }): JSX.Element | null;
  export function renderCompleteConsultationPdf(content: ConsultationContent, header: FullPdfHeader, letterhead: string, opinion?: OpinionForPdf | null): Promise<Buffer>;
  // dossier-document.tsx
  export interface DossierEntry { content: ConsultationContent; header: FullPdfHeader; role: string }
  ```

**Rules:** `src/lib/pdf/CLAUDE.md` (react-pdf only, no hooks, existing documents do not grow, reuse shared exports), 06-security, 05-testing, typescript/coding-standards.

Render rules: same order as the screen (sections → "Outros dados da deps" → "Sem informação: …" → "Dados da consulta" → opinion → "Documento gerado automaticamente · Reino do Crédito"). Collapsed parts print in full (spec §3.2 item 2). Score section uses `ScoreBar` with `full.scoreValue` when not null. `table` uses the shared `Table` with `widths = columns.map(() => 1 / columns.length)` (small font for wide tables); `fields` uses `Field` in the `pdfStyles.grid`; `json` prints as monospace-free `Text` lines. Fallback note: `ConsultationPdfPage` passes `endereco: [header.endereco, FULL_DATA_UNAVAILABLE].filter(Boolean).join(" · ")` to `FullConsultationPage` (shortcut: reuses the existing header line so `consultation-full-document.tsx` does not grow; give the note its own line if that file is ever split).

Route changes:
- Staff consultation route: keep the 401/403/404 and the `status !== "completed"` 409. `content = toConsultationContent(await loadLatestPayload(session, params.id), await loadCanonicalResult(session, params.id))`; both null → current 409 message. Header `cpf` = `query.type === "PJ" ? formatCNPJ(query.document) : formatCPF(query.document)`, `docLabel` = `query.type === "PJ" ? "CNPJ" : "CPF"`, `endereco` = `content.view?.subject.location ?? undefined`, name `query.document_name ?? content.view?.subject.name ?? "—"`. Render with `renderCompleteConsultationPdf(content, header, letterheadDataUri(), opinion)`.
- Staff dossier route: per member, `content` the same way; skip only when both are null; header document from `m.document` / `m.type`.
- Portal route: per member `content = toConsultationContent(m.payload, m.canonical)`; skip only when both are null; `cpf` = `m.canonical ? formatSubjectDocument(m.canonical) : "—"`.
- `DossierDocument` maps entries to `<ConsultationPdfPage {...e.content} header={...} letterhead={letterhead} />` (role prefix unchanged).

- [ ] Step: write failing tests.

`src/lib/pdf/complete-consultation-document.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import fixture from "@/lib/deps/__fixtures__/smart-pf-002.json";
import { adapt } from "@/lib/deps/adapter";
import { toConsultationContent } from "@/lib/consultations/full-view";
import { renderCompleteConsultationPdf } from "./complete-consultation-document";

const LETTERHEAD = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const header = { name: "Maria Exemplo da Silva", cpf: "***.982.247-**", produto: "Smart PF", data: "19/10/2026", consultante: "Reino do Crédito", usuario: "u1" };
// canonical(...) as in view-model.test.ts:11-21

describe("renderCompleteConsultationPdf", () => {
  it("renders the full payload view", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(fixture, null), header, LETTERHEAD);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
  it("renders the canonical fallback when there is no payload", async () => {
    const pdf = await renderCompleteConsultationPdf(toConsultationContent(null, canonical(fixture)), header, LETTERHEAD);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});
```
The section titles "SCR", "Parecer Smart", "Renda presumida" (spec §5) are proven by the shared `FullConsultationView` order test (Task 2) plus this render: the PDF text stream is compressed, so the test does not grep it.

`route.test.ts`: replace the `view-model` mock with
```ts
vi.mock("@/lib/consultations/view-model", () => ({ formatSubjectDocument: () => "390.533.447-05" }));
vi.mock("@/lib/consultations/full-view", () => ({
  toConsultationContent: (payload: unknown, canonical: { name: string } | null) => ({
    full: payload ? { marker: "full" } : null,
    view: canonical ? { subject: { name: canonical.name, documentLabel: "CPF", location: null } } : null,
  }),
}));
```
add `payload: null` to each member at lines 46-48, keep every existing assertion, and add:
```ts
it("renders a member that has a payload but no canonical result", async () => {        // Review Focus 2
  state.getMyDelivery.mockResolvedValue(delivery({ members: [
    { consultationId: "c4", type: "PF", name: "Só payload", product: null, status: "payload_incompatible", canonical: null, payload: { mix: {} }, opinion: null },
  ] }));
  await call();
  const [data] = state.render.mock.calls[0];
  expect(data.entries).toHaveLength(1);
  expect(data.entries[0].content).toEqual({ full: { marker: "full" }, view: null });
  expect(data.entries[0].header.cpf).toBe("—");
});
```
- [ ] Step: run `npx vitest run src/lib/pdf "src/app/(portal)/portal/pesquisas/[id]/pdf/route.test.ts"`, expected FAIL.
- [ ] Step: implement the two new PDF files, the `export` keywords, the dossier document and the three routes. Each new file ≤ 350 lines.
- [ ] Step: run `npx vitest run src/lib/pdf "src/app/(portal)" && npm run type-check && npm run lint && wc -l src/lib/pdf/consultation-full-document.tsx src/lib/pdf/consultation-document.tsx`, expected PASS and 464 / 492 lines.
- [ ] Step: commit.
```bash
git add src/lib/pdf/generic-block.tsx src/lib/pdf/complete-consultation-document.tsx \
  src/lib/pdf/complete-consultation-document.test.ts src/lib/pdf/consultation-full-document.tsx \
  src/lib/pdf/dossier-document.tsx "src/app/(dashboard)/consultations/[id]/pdf/route.ts" \
  "src/app/(dashboard)/dossiers/[id]/pdf/route.ts" "src/app/(portal)/portal/pesquisas/[id]/pdf/route.ts" \
  "src/app/(portal)/portal/pesquisas/[id]/pdf/route.test.ts"
git commit -m "feat(pdf): PDFs da consulta, do dossiê e do portal com o retorno completo da deps"
```

---

## Waves

| Wave | Tasks | Why together |
|---|---|---|
| 1 | Task 1 (`backend-specialist`, sonnet), Task 3 (`database-architect`, sonnet) | No dependency; disjoint files. |
| 2 | Task 2 (`backend-specialist`, sonnet), Task 4 (`backend-specialist`, sonnet) | Both need Task 1; Task 4 also needs Task 3 (wave 1). Disjoint files (`src/lib/consultations/*` + `src/types/` vs `src/lib/ai/*`, `src/actions/*`, `src/lib/orders/ai*`). |
| 3 | Task 5 (`frontend-specialist`, sonnet), Task 6 (`frontend-specialist`, sonnet) | Both need Tasks 2 and 3. Disjoint files (`src/components/*` + staff page vs `src/lib/pdf/*` + PDF routes). |

The coordinator commits after each wave, per task, in task order. One `/code-review` with `code-reviewer` and `security-reviewer` after Task 6, for the whole issue.

## Post-deploy follow-up

- (post-deploy) First real Smart PJ 010 consultation: confirm `empresa`, `quadroSocietario` and `balanco` render through the generic renderer, confirm `pruneForAi` removed the PJ contact and address keys, and open an issue for PJ cards.
