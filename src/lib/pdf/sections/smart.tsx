import type { ReactNode } from "react";

import type { FullSection, SectionPart } from "@/types/consultation-view";

import { CLASSIFICATION_PART, renderClassification } from "./classification";
import { findPart } from "./cells";
import { formatMetricPercents, renderMetrics } from "./metrics";
import { PARECER_PART, RESULT_PART, renderRules } from "./rules";
import { GenericPart, SectionTitle, partReserve } from "./shared";

const POSITIVE_PART = "Métricas positivas";
const NEGATIVE_PART = "Métricas negativas";

// Parecer Smart na ordem do relatório: classificação, regras, métricas e, por fim, o resto das partes pelo motor genérico.
export function renderSmart(section: FullSection): ReactNode | null {
  const classification = renderClassification(section);
  const rules = renderRules(section.title, findPart(section, PARECER_PART), findPart(section, RESULT_PART));
  const positive = renderMetrics(findPart(section, POSITIVE_PART));
  const negative = renderMetrics(findPart(section, NEGATIVE_PART));
  if (!classification && !rules && !positive && !negative) return null;

  const consumed = new Set<SectionPart | undefined>([
    classification ? findPart(section, CLASSIFICATION_PART) : undefined,
    rules ? findPart(section, PARECER_PART) : undefined,
    rules ? findPart(section, RESULT_PART) : undefined,
    positive ? findPart(section, POSITIVE_PART) : undefined,
    negative ? findPart(section, NEGATIVE_PART) : undefined,
  ]);
  const left = section.parts.filter((part) => !consumed.has(part)).map((part) => ({ ...part, value: formatMetricPercents(part.value) }));
  return (
    <>
      {classification}
      {rules}
      {positive}
      {negative}
      {left.length > 0 ? <SectionTitle title={rules ? `${section.title} · outros dados` : section.title} reserve={partReserve(left[0])} /> : null}
      {left.map((part, i) => (
        <GenericPart key={i} part={part} />
      ))}
    </>
  );
}
