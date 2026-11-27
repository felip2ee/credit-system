import { ScreenHeader } from "@/components/ui/screen-header";

// Cabeçalho das subpáginas: voltar para a central no topo, título (h1) e a frase do que se configura.
export function SettingsHeader({ title, description }: { title: string; description: string }) {
  return (
    <>
      <ScreenHeader
        // md+: a barra do painel já está visível; o cabeçalho fica estático e sem sangria.
        className="-mx-4 -mt-4 md:static md:mx-0 md:mt-0"
        title={title}
        backHref="/superadmin/settings"
        backLabel="Voltar para Configurações"
      />
      <p className="text-sm text-muted-foreground">{description}</p>
    </>
  );
}
