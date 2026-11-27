import type { ReactNode } from "react";

interface BureauSectionLink {
  id: string;
  label: string;
}

// Índice por âncoras no topo do detalhe: cada link leva à seção de mesmo id. Alvo de 44 px abaixo de `md`.
export function BureauSectionNav({ sections }: { sections: BureauSectionLink[] }) {
  return (
    <nav aria-label="Seções do Bureau">
      <ul className="flex flex-wrap gap-1">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="inline-flex min-h-11 items-center rounded-full border border-border px-3.5 text-sm font-bold text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

interface BureauSectionProps extends BureauSectionLink {
  description?: string;
  children: ReactNode;
}

export function BureauSection({ id, label, description, children }: BureauSectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="space-y-4 border-t border-border pt-4">
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-base font-bold">
          {label}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}
