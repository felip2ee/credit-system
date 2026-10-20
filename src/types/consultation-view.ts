// Visão completa do payload bruto da DEPS: seções tipadas + blocos genéricos (100% do retorno).

export type GenericValue =
  | { kind: "text"; text: string }
  | { kind: "fields"; fields: GenericField[] }
  | { kind: "table"; columns: { key: string; label: string }[]; rows: string[][] }
  | { kind: "json"; text: string };

export interface GenericField {
  key: string;
  label: string;
  value: GenericValue;
}

export interface GenericBlock {
  key: string;
  title: string;
  note: string | null;
  value: GenericValue;
}

export interface SectionPart {
  title: string | null;
  value: GenericValue;
  collapsed: boolean;
}

export type FullSectionId =
  | "score"
  | "smart"
  | "scr"
  | "rendaPresumida"
  | "restricoes"
  | "pessoa"
  | "contatos"
  | "consultas";

// sources = chaves de `mix` consumidas pela seção (prova de que nenhuma chave fica sem destino).
export interface FullSection {
  id: FullSectionId;
  title: string;
  sources: string[];
  parts: SectionPart[];
}

export interface FullConsultationView {
  sections: FullSection[]; // itens 1-8 da spec §3.2, na ordem, só os presentes
  generic: GenericBlock[]; // item 9, na ordem do payload
  missing: { key: string; label: string }[]; // item 10
  meta: GenericField[]; // item 11 (META_KEYS + chaves da raiz fora de mix)
  scoreValue: number | null; // barra de score do PDF
}
