import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FullConsultationView, SectionPart } from "@/types/consultation-view";

import { GenericValueView } from "./generic-block";

function Part({ part }: { part: SectionPart }) {
  if (part.collapsed) {
    return (
      <details className="rounded-md border">
        <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium">{part.title ?? "Detalhes"}</summary>
        <div className="border-t px-4 py-3">
          <GenericValueView value={part.value} />
        </div>
      </details>
    );
  }
  return (
    <div className="space-y-2">
      {part.title && <h3 className="text-sm font-medium">{part.title}</h3>}
      <GenericValueView value={part.value} />
    </div>
  );
}

export function FullConsultationResult({ view }: { view: FullConsultationView }) {
  return (
    <div className="space-y-6">
      {view.sections.map((section) => (
        <Card key={section.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">{section.title}</CardTitle>
            {section.id === "score" && view.scoreValue != null && <p className="text-4xl font-semibold">{view.scoreValue}</p>}
          </CardHeader>
          <CardContent className="space-y-4">
            {section.parts.map((part, i) => (
              <Part key={`${part.title ?? ""}-${i}`} part={part} />
            ))}
          </CardContent>
        </Card>
      ))}
      {view.generic.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Outros dados</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {view.generic.map((block) => (
              <div key={block.key} className="space-y-2">
                <h3 className="text-sm font-medium">{block.title}</h3>
                {block.note && <p className="text-xs text-muted-foreground">{block.note}</p>}
                <GenericValueView value={block.value} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
