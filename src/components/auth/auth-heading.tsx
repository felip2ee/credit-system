// Título curto e compacto + uma linha de apoio (telas de acesso e cadastro).
export function AuthHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-1 text-center">
      <h1 className="text-balance text-base font-bold">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
