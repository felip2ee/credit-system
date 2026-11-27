import { ScreenHeader } from "@/components/ui/screen-header";

interface DetailHeaderProps {
  title: string;
  backHref: string;
  backLabel: string;
}

// Voltar no topo das telas de detalhe: fixo abaixo de `md` (sangra até a borda da tela), estático a partir de `md`.
export function DetailHeader({ title, backHref, backLabel }: DetailHeaderProps) {
  return (
    <ScreenHeader
      title={title}
      backHref={backHref}
      backLabel={backLabel}
      className="-mx-4 -mt-4 mb-4 px-2 md:static md:mx-0 md:mt-0 md:px-0"
    />
  );
}
