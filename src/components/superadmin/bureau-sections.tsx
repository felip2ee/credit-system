import type { ReactNode } from "react";

interface BureauSectionLink {
  id: string;
  label: string;
}

// Índice por âncoras no topo do detalhe: cada link leva à seção de mesmo id. Alvo de 44 px abaixo de `md`.
export function BureauSectionNav({ sections }: { sections: BureauSectionLink[] }) {
  return (
    <nav aria-label="Seções do Bureau" className="-mx-1 overflow-x-auto">
      <ul className="flex w-max gap-1 px-1">
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

// `scroll-mt-20` deixa o título abaixo do cabeçalho fixo ao seguir a âncora.
export function BureauSection({ id, label, description, children }: BureauSectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 space-y-4 border-t border-border pt-4">
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
