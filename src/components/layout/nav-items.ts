import type { Permission } from "@/lib/db/permissions";

export interface NavItem {
  href: string;
  label: string;
  // Sem permissão = visível para todos os papéis do painel.
  permission?: Permission;
}

export function visibleNavItems<T extends NavItem>(items: readonly T[], permissions: readonly Permission[]): T[] {
  return items.filter((item) => !item.permission || permissions.includes(item.permission));
}

// Fonte única dos itens do painel do Bureau: a sidebar (com ícones) e o menu do celular leem esta lista.
export const DASHBOARD_NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/dossiers", label: "Pesquisas" },
  { href: "/holders", label: "Titulares" },
  { href: "/scr", label: "Autorizações SCR" },
  { href: "/settings/catalog", label: "Catálogo" },
  { href: "/settings/wallet", label: "Carteira" },
  { href: "/settings/counter-payments", label: "Pagamentos de balcão", permission: "counter:read" },
  { href: "/settings/payouts", label: "Repasses", permission: "payout:read" },
  { href: "/afiliados", label: "Afiliados", permission: "affiliates:manage" },
  { href: "/settings", label: "Configurações" },
];

export const SUPERADMIN_NAV_ITEMS: readonly NavItem[] = [
  { href: "/superadmin", label: "Bureaus" },
  { href: "/superadmin/products", label: "Produtos" },
  { href: "/superadmin/payouts", label: "Repasses" },
  { href: "/superadmin/saques", label: "Saques" },
  { href: "/superadmin/nfse", label: "NFS-e" },
  { href: "/superadmin/notifications", label: "Notificações" },
  { href: "/superadmin/settings/prompts", label: "Prompts da IA" },
  { href: "/superadmin/settings/scr", label: "Termo SCR" },
  { href: "/superadmin/settings/afiliados", label: "Afiliados" },
];

const SETTINGS_SUBPAGES = ["/settings/catalog", "/settings/wallet", "/settings/counter-payments", "/settings/payouts"];

export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/" || href === "/superadmin") return pathname === href;
  if (href === "/settings" && SETTINGS_SUBPAGES.some((sub) => pathname.startsWith(sub))) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
