import { BRAND_ASSETS, BRAND_NAME } from "@/lib/brand/brand";

// Variante do kit para fundo escuro (a sidebar é escura). Não recolorir nem esticar.
const LOGO_ON_DARK = "/brand/rainha-cred/logo/rainha-cred-logo-completa-fundo-escuro.svg";

/* eslint-disable @next/next/no-img-element -- SVG estático do kit, sem otimização de imagem */
export function SidebarBrand({ label }: { label?: string }) {
  return (
    <div className="flex h-20 items-end justify-between gap-3 border-b border-sidebar-border px-6 pb-3">
      <img src={LOGO_ON_DARK} alt={BRAND_NAME} className="h-14 w-auto object-contain" />
      {label && (
        <span className="text-base font-bold uppercase leading-none tracking-wide text-sidebar-foreground/70">{label}</span>
      )}
    </div>
  );
}

export function MobileBrand() {
  return <img src={BRAND_ASSETS.symbol} alt={BRAND_NAME} className="h-9 w-9 object-contain" />;
}
