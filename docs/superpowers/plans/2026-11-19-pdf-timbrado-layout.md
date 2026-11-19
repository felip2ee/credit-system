# PDF Letterhead Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, with the parallel-wave override in `.claude/rules/08-parallel-subagent-driven-development.md`. Implementers do not commit; the coordinator commits per task.

**Goal:** Render the consultation PDF and the dossier PDF on the Rainha Cred letterhead with one table standard, a first-page summary and a dossier cover, without losing any data item.

**Architecture:** All changes stay in `src/lib/pdf/`. A small theme module holds page metrics and visual tokens; the frame draws the letterhead, logo, footer and running header; one table component with pure layout helpers replaces the three table patterns; curated sections sit in front of the generic renderer, which remains the fallback for every other data item.

**Tech Stack:** `@react-pdf/renderer` 4.5.1 (`renderToBuffer`), TypeScript, vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-19-pdf-timbrado-design.md` (pt-BR). Section 0 limits this branch to layout. Read sections 0, 2, 3, 6 and 8 before any task.

## Global Constraints

- Edit only files in `src/lib/pdf/` and `public/brand/rainha-cred/timbrado/`, plus `docs/design.md` in Task 5. Never edit anything under `src/app/`.
- Exported names that code outside `src/lib/pdf/` imports keep compatible signatures: `PdfFrame` (new fields optional only), `renderCompleteConsultationPdf`, `renderDossierPdf`, `DossierEntry`, `DossierPdfData`, `FullPdfHeader`, `OpinionForPdf`, `OpinionBlock`, `ConsultationPdfPage`, `FullConsultationPage`, `pdfStyles`.
- No data item is dropped. A section without a curated layout renders through the generic renderer.
- Font: react-pdf built-in `Helvetica` / `Helvetica-Bold`. Body 10 pt, table 9 pt, table header 8.5 pt uppercase, section title 12 pt bold, summary figure 18 pt, name 22 pt.
- Colours: ink `#1E2A26`, muted `#6B7773`, green `#0B7A66`, gold text `#8F6B1F`, gold rule `#C9A24A`, rules `#D6DCD9` / `#E6EAE8`, zebra `#F8F9F8`, positive `#1F7A5A`, negative `#B3402F`.
- Column widths (pt): money 84, percent 78, number 56, date 66, yes/no 52, short text 80; text columns share the rest. Row height 18 pt.
- Formats: money `R$ 1.234,56`; percent always two decimals `12,34%`; date `dd/mm/aaaa`. Reuse the formatters that already exist in `@/lib/utils` or the view-model before writing one.
- Visible text and code comments in pt-BR; identifiers in English. Do not grow `consultation-full-document.tsx` (437 lines) or `consultation-document.tsx`: move code out instead.
- Letterhead: `public/brand/rainha-cred/timbrado/timbrado-a4.jpg` (1240×1754, already in the worktree). Logo: `public/brand/rainha-cred/logo/rainha-cred-logo-completa-transparente.png`, not recoloured.
- Visual reference only (do not copy code): `/private/tmp/claude-501/-Users-felipeborges-Documents-projetos-Eliane-Moreira-credit-system/b6be582e-a9ad-4f7a-ae5c-13a7650c59b6/scratchpad/spike3/` (`pa-1.png`..`pa-4.png`, `spike3.test.tsx`). Rasterizer for visual checks: `swift <scratchpad>/r.swift <pdf> <output-prefix>`; write render output only to the scratchpad.
- Checks: `npx vitest run src/lib/pdf`, `npm run type-check`, `npm run lint`.

## Review Focus

1. A table longer than one page: the header repeats on the new page and no row splits. Test in Task 2 (`chunkRows`).
2. A very long unbroken token (URL, 40-digit number) in a narrow cell: it wraps inside the cell. Test in Task 1 (hyphenation callback).
3. A section the curated layouts do not know (new API field): it still appears in the PDF text. Test in Task 3 ("nothing lost").
4. Missing data: no score, no SCR, no opinion, empty address list: the page renders and the summary shows "—". Test in Task 3.
5. A dossier with one member and no opinion, and one with a company plus several partners: cover lists every member and each member page names its role. Test in Task 5.

---

### Task 1: Theme, frame, fonts

**Files:**
- Create: `src/lib/pdf/theme.ts`
- Modify: `src/lib/pdf/brand-frame.tsx`, `src/lib/pdf/fonts.ts`
- Test: `src/lib/pdf/brand-frame.test.ts` (rewrite), `src/lib/pdf/fonts.test.ts` (create)

**Depends-on:** none

**Interfaces — Produces:**
- `theme.ts`: `PDF_COLORS` (keys `ink, muted, green, goldText, goldRule, rule, ruleSoft, zebra, positive, negative`), `PDF_TYPE` (keys `name, figure, section, body, table, tableHeader` → pt), `PDF_PAGE` (`width, height, paddingTop, paddingBottom, paddingX, contentWidth`), `PDF_COLUMN_WIDTH` (keys `money, percent, number, date, bool, short`), `PDF_ROW_HEIGHT`.
- `brand-frame.tsx`: `PdfFrame` gains optional `whatsapp?: string`, `instagram?: string`, `running?: { name: string; document?: string; label: string }`. `PdfBrandFrame({ frame })` draws, all `fixed`: the letterhead image full-page, the logo top-left (about 52 pt tall), the footer line (e-mail · WhatsApp · Instagram, only the values present; "Página X de Y" right) and, from page 2 on, the running line beside the logo (`name`, `document`, `"<label> (continuação)"`). `PDF_PAGE_PADDING_TOP` / `PDF_PAGE_PADDING_BOTTOM` stay exported and take their values from `PDF_PAGE`.
- `fonts.ts`: `PDF_FONT_FAMILY = "Helvetica"`, `PDF_FONT_FAMILY_BOLD = "Helvetica-Bold"`; `registerPdfFonts()` registers only the hyphenation callback; exported pure `breakLongToken(word: string): string[]`.

**Requirements:**
- Measure the final letterhead and set the safe area so no content touches the top band, the key, the bottom band or the medal. Starting values: top 92, bottom 96, sides 46. On page 1 the identity block stays left of the key (Task 3 uses `PDF_PAGE`).
- Footer text white on the green band, starts right of the medal, one line. Check in a rendered PNG.
- Remove the Atkinson registration; leave the TTF files in place and report them as now unused.

**Test cases:**
- `breakLongToken`: a word of 16 characters or fewer returns `[word]`; a 60-character token returns parts of at most 16 characters whose join equals the token; empty string returns `[""]`.
- Frame render (use `pdf-text.testing.ts`): footer shows e-mail only when `whatsapp` and `instagram` are absent; shows all three when present; a 2-page document shows "Página 1 de 2" and "Página 2 de 2"; the running line text appears on page 2 and not on page 1.

**Visual check (once, inside this task):** render a 2-page document, rasterize, read both PNGs, confirm nothing overlaps the key, medal or bands.

---

### Task 2: Table standard and generic renderer

**Files:**
- Create: `src/lib/pdf/table-layout.ts`, `src/lib/pdf/table.tsx`
- Modify: `src/lib/pdf/generic-block.tsx`
- Test: `src/lib/pdf/table-layout.test.ts` (create), `src/lib/pdf/generic-block.test.ts` (rewrite)

**Depends-on:** Task 1

**Interfaces — Consumes:** `PDF_COLORS`, `PDF_TYPE`, `PDF_PAGE`, `PDF_COLUMN_WIDTH`, `PDF_ROW_HEIGHT` from `theme.ts`.

**Interfaces — Produces:**
- `table-layout.ts` (pure, no react-pdf import):
  - `type ColumnType = "text" | "short" | "money" | "percent" | "number" | "date" | "bool"`
  - `inferColumnType(label: string, cells: string[]): ColumnType`
  - `dropEmptyColumns<T extends { label: string }>(columns: T[], rows: string[][]): { columns: T[]; rows: string[][] }`
  - `columnLayout(types: ColumnType[], contentWidth: number): { width: number; align: "left" | "right" | "center" }[]`
  - `chunkRows<T>(rows: T[], firstChunk: number, nextChunk: number): T[][]`
- `table.tsx`: `PdfTable({ columns, rows, title?, indent? })` where `columns: { label: string; type?: ColumnType }[]` and `rows: { cells: string[]; kind?: "normal" | "subtotal"; level?: 0 | 1 | 2 }[]`. `PdfFields({ fields })` where `fields: { label: string; value: string }[]`, 2-column grid at 50%.
- `generic-block.tsx`: `PdfGenericValue` keeps its signature and renders through `PdfTable` and `PdfFields`. `columnWidths` is removed if nothing outside `src/lib/pdf/` imports it (check first).

**Requirements:** spec section 6.3. Header aligned like its column, no fill, thin rule beneath. Zebra on body rows. Subtotal rows bold; `level` indents the first cell by 12 pt per level. Each chunk is one `wrap={false}` block with its own header; chunks after the first get the title `"<title> (continuação)"`. Chunk sizes come from the row count and the space a page holds, never tuned to one fixture; a table that fits on the current page is one chunk.

**Test cases:**
- `inferColumnType`: all cells `R$ …` → `money`; all cells ending `%` → `percent`; all cells integers or decimals → `number`; all cells `dd/mm/aaaa` → `date`; all cells in `Sim`/`Não` → `bool`; mixed → `text`; all cells `—` or empty with a money-like label keeps `text`; short labels such as `Operadora`, `Tipo`, `Resultado`, `UF` with cells of 12 characters or fewer → `short`.
- `dropEmptyColumns`: a column whose every cell is `""` or `—` is removed from columns and rows; a column with one value stays.
- `columnLayout`: widths sum to `contentWidth` (±0.5); `money`, `percent`, `number` are right-aligned with the widths in Global Constraints; `bool` centred; two text columns share the remainder; when fixed widths exceed `contentWidth`, widths scale down and still sum to `contentWidth`.
- `chunkRows`: 0 rows → `[]`; 5 rows with first 10 → one chunk; 25 rows with first 10, next 12 → sizes `[10, 12, 3]`; no row lost or duplicated.
- `PdfGenericValue` render: a list of objects prints every label and value once per chunk header; a nested list stays inside the content width.

---

### Task 3: Consultation document — summary and curated sections

**Files:**
- Create: `src/lib/pdf/sections/` (one file per section group: `identity.tsx`, `summary.tsx`, `score.tsx`, `classification.tsx`, `rules.tsx`, `metrics.tsx`, `scr.tsx`, `contact-data.tsx`, `index.ts`)
- Modify: `src/lib/pdf/complete-consultation-document.tsx`, `src/lib/pdf/consultation-full-document.tsx`
- Test: `src/lib/pdf/complete-consultation-document.test.ts` (rewrite), `src/lib/pdf/sections/sections.test.ts` (create)

**Depends-on:** Task 1, Task 2

**Interfaces — Consumes:** `PdfTable`, `PdfFields`, `ColumnType` (Task 2); `PdfBrandFrame`, `PdfFrame.running`, `PDF_PAGE` (Task 1).

**Interfaces — Produces:**
- `ConsultationPdfPageProps` gains optional `roleLabel?: string` (printed in the eyebrow as `"<roleLabel> · <produto>"`), `documentKind?: "consulta" | "dossie"` (default `"consulta"`; sets the eyebrow word and the running label) and `closingNote?: boolean` (default `true`; prints "Documento gerado automaticamente").
- `sections/index.ts`: `renderCuratedSection(section, context): ReactNode | null`. A `null` result sends the section to `PdfGenericValue`.

**Requirements:** spec sections 6.4 and 0.
- Read `@/lib/consultations/full-view` and the view-model first to learn the real section keys and shapes for PF (`src/lib/deps/__fixtures__/smart-pf-002.json`) and PJ (`pj-current.json`). A curated layout matches by section key; it must print every field the generic renderer would print for that section, or return `null`.
- Order: identity, summary, score, classification, rules, metrics, SCR, then the remaining sections in their current order, then the AI opinion.
- Eyebrow: `"RELATÓRIO DE CONSULTA · <produto>"`. Omit `"· Usuário …"` when `header.usuario` matches a UUID.
- Summary: five figures (Score with risk band, Classificação, Parecer, Limite sugerido, Total SCR); a missing figure prints "—".
- SCR: every group uses the columns Descrição / Valor / Percentual, modality as `subtotal`, term bands as `level: 1` or `2`.
- Addresses: one line per address. E-mails: one per line.
- `consultation-full-document.tsx` must end smaller than 437 lines: move `ScoreBar` and the legacy table into `sections/` or delete what has no caller inside the repo.

**Test cases:**
- "Nothing lost" (PF and PJ fixtures): collect every non-empty leaf label and value that the content passes to the document; each one appears in the text extracted from the PDF (`pdf-text.testing.ts`). Compare after normalising whitespace and the formats in Global Constraints.
- A section with an unknown key renders through the generic path and its values appear in the text.
- Content with no score, no SCR and no rules renders; the summary prints "—" five times at most and no curated section throws.
- `header.usuario` as a UUID is not printed; as a name it is printed.
- `roleLabel: "Sócio"` prints "Sócio · " in the eyebrow; `closingNote: false` omits the closing note.

**Visual check (once, inside this task):** render the PF and PJ fixtures, rasterize, read every page: no collision, no overflow, no orphan header, no page under 60% filled except the last, nothing on the key or medal.

---

### Task 4: AI opinion block

**Files:**
- Modify: `src/lib/pdf/markdown-pdf.tsx`
- Test: `src/lib/pdf/markdown-pdf.test.ts` (create)

**Depends-on:** Task 2

**Interfaces — Consumes:** `PdfTable`, theme tokens. **Produces:** `OpinionBlock({ opinion })` and `MarkdownPdf({ md })` with unchanged signatures; `OpinionForPdf` unchanged.

**Requirements:** spec section 6.5. Print, in this order, each part that has content: aptitude and profile, suggested limit and its notes, summary, strengths, attention points, action plan, markdown report. Today the structured parts are skipped when `relatorioMarkdown` exists. Markdown tables render through `PdfTable`. Remove the local copies of page metrics and colours in favour of `theme.ts`.

**Test cases:**
- An opinion with every field and a markdown report: the text contains the summary, one strength, one attention point, one action-plan item, the limit note and a heading from the markdown.
- An opinion with only `relatorioMarkdown`: renders, no empty headings for the missing parts.
- An opinion with only structured fields: renders without the report section.
- A markdown table with 3 columns and a money column: cells appear in the text and the document renders.

---

### Task 5: Dossier cover, member pages, docs

**Files:**
- Create: `src/lib/pdf/dossier-cover.tsx`
- Modify: `src/lib/pdf/dossier-document.tsx`, `src/lib/pdf/CLAUDE.md`, `docs/design.md`
- Test: `src/lib/pdf/dossier-document.test.ts` (create)

**Depends-on:** Task 3, Task 4

**Interfaces — Consumes:** `ConsultationPdfPage` with `roleLabel`, `documentKind`, `closingNote` (Task 3); `OpinionBlock` (Task 4); `PdfTable` (Task 2). **Produces:** `renderDossierPdf(data, frame)` with unchanged signature; `DossierEntry` and `DossierPdfData` unchanged (new fields optional only).

**Requirements:** spec section 6.6.
- First page is the cover: eyebrow `"DOSSIÊ · Pessoa Física"` or `"DOSSIÊ · Empresarial"` (from the dossier kind already in `DossierPdfData`; read the type to find it), holder name and document, date, members table (Papel, Nome, Documento, Situação da consulta). A one-member dossier also has a cover.
- Each member starts on a new page with `roleLabel` and `documentKind: "dossie"`; the running line shows `"<Papel> · <nome>"` on every page of that member; `closingNote` is `true` only after the last block of the dossier.
- The opinion page keeps its current data source.
- Update `src/lib/pdf/CLAUDE.md` (font, letterhead frame, `theme.ts`, table standard, sections folder) and the PDF part of `docs/design.md`. Keep both short.

**Test cases:**
- PJ_FULL with a company and two partners: the cover text lists three members with roles "Empresa", "Sócio", "Sócio"; the text contains each member's name on its own pages; "Documento gerado automaticamente" appears once.
- PF with one member and no opinion: cover plus member pages, renders, no opinion heading.
- PF with an opinion: the opinion summary appears after the member pages.

**Visual check (once, inside this task):** render the PJ_FULL case, rasterize, read the cover, the first page of each member and the last page.

---

## Waves

1. Task 1
2. Task 2
3. Task 3 ∥ Task 4 (disjoint files)
4. Task 5

## Post-deploy follow-up

- `(post-deploy)` Download one real consultation PDF and one real dossier PDF in production and check the letterhead, the logo and the footer.

## Out of this plan (spec section 0)

Superadmin contacts, user name in the identity line, and the AI-opinion download fix (owned by another agent).
