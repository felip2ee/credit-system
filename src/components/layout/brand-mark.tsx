import { BRAND_ASSETS, BRAND_NAME } from "@/lib/brand/brand";

// Variante do kit para fundo escuro (a sidebar é escura). Não recolorir nem esticar.
const LOGO_ON_DARK = "/brand/rainha-cred/logo/rainha-cred-logo-completa-fundo-escuro.svg";

/* eslint-disable @next/next/no-img-element -- SVG estático do kit, sem otimização de imagem */
export function SidebarBrand({ label }: { label?: string }) {
  return (
    <div className="flex h-20 items-center gap-3 border-b border-sidebar-border px-6">
      <img src={LOGO_ON_DARK} alt={BRAND_NAME} className="h-14 w-auto object-contain" />
      {label && <span className="text-sm font-bold">{label}</span>}
    </div>
  );
}

export function MobileBrand() {
  return (
    <span className="flex items-center gap-2 font-bold">
      <img src={BRAND_ASSETS.symbol} alt="" className="h-9 w-9 object-contain" />
      <span>{BRAND_NAME}</span>
    </span>
  );
}
