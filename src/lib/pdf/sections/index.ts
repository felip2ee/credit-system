import type { ReactNode } from "react";

import type { FullSection, FullSectionId } from "@/types/consultation-view";

import type { CuratedContext } from "./cells";
import { renderContacts } from "./contact-data";
import { renderSmart } from "./smart";
import { renderScore } from "./score";
import { renderScr } from "./scr";

export { confidentialLine, eyebrowText, Identity } from "./identity";
export { GenericBlocks, GenericSection, SectionTitle } from "./shared";
export { ScoreTrack } from "./score";
export { Summary, summaryFigures } from "./summary";
export type { CuratedContext } from "./cells";

const RENDERERS: Partial<Record<FullSectionId, (section: FullSection, context: CuratedContext) => ReactNode | null>> = {
  score: renderScore,
  smart: renderSmart,
  scr: renderScr,
  contatos: renderContacts,
};

// Desenho próprio da seção, ou null: o motor genérico imprime a seção inteira. Cada desenho imprime todo
// dado que o motor imprimiria; o que não reconhece volta para o motor.
export function renderCuratedSection(section: FullSection, context: CuratedContext): ReactNode | null {
  return RENDERERS[section.id]?.(section, context) ?? null;
}
