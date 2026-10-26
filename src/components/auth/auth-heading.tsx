// Título grande e curto + uma linha de apoio (padrão de login).
export function AuthHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-2 text-center">
      <h1 className="text-balance text-3xl font-bold">{title}</h1>
      {description && <p className="text-lg text-muted-foreground">{description}</p>}
    </div>
  );
}
