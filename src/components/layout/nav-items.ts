import type { Permission } from "@/lib/db/permissions";

export interface NavItem {
  href: string;
  label: string;
  // Sem permissão = visível para todos os papéis do painel.
  permission?: Permission;
  // Título do grupo na navegação. Sem grupo = lista única, sem título (superadmin).
  group?: string;
}

export interface NavGroup<T extends NavItem = NavItem> {
  title: string | null;
  items: T[];
}

// Agrupa na ordem em que cada título aparece. Grupo sem item não existe, então some sozinho.
export function groupNavItems<T extends NavItem>(items: readonly T[]): NavGroup<T>[] {
  const groups: NavGroup<T>[] = [];
  for (const item of items) {
    const title = item.group ?? null;
    const group = groups.find((g) => g.title === title);
    if (group) group.items.push(item);
    else groups.push({ title, items: [item] });
  }
  return groups;
}

export function visibleNavItems<T extends NavItem>(items: readonly T[], permissions: readonly Permission[]): T[] {
  return items.filter((item) => !item.permission || permissions.includes(item.permission));
}

// Fonte única dos itens do painel do Bureau: a sidebar (com ícones) e o menu do celular leem esta lista.
export const DASHBOARD_NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard", group: "Operação" },
  { href: "/dossiers", label: "Pesquisas", group: "Operação" },
  { href: "/holders", label: "Titulares", group: "Operação" },
  { href: "/scr", label: "Autorizações SCR", group: "Operação" },
  { href: "/settings/wallet", label: "Carteira", group: "Financeiro" },
  { href: "/settings/cupons", label: "Cupons", permission: "coupons:read", group: "Financeiro" },
  { href: "/settings/catalog", label: "Catálogo", group: "Financeiro" },
  { href: "/afiliados", label: "Afiliados", permission: "affiliates:read", group: "Financeiro" },
  { href: "/settings", label: "Configurações", group: "Conta" },
];

export interface SettingsPage extends NavItem {
  description: string;
}

// Central de configurações: a mesma permissão que cada página exige ao abrir.
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { href: "/settings/security", label: "Segurança (MFA)", description: "Cadastre um autenticador para proteger o seu acesso." },
  { href: "/settings/users", label: "Equipe", permission: "users:manage", description: "Convide e gerencie operadores e administradores." },
  { href: "/settings/audit", label: "Auditoria", permission: "audit:read", description: "Veja quem consultou o quê e quando." },
  { href: "/settings/catalog", label: "Catálogo", permission: "catalog:read", description: "Consulte os produtos e os preços do bureau." },
  { href: "/settings/cupons", label: "Cupons", permission: "coupons:read", description: "Crie e acompanhe cupons de desconto." },
  { href: "/settings/wallet", label: "Carteira", permission: "wallet:read", description: "Veja o saldo e os lançamentos da carteira." },
  { href: "/settings/counter-payments", label: "Pagamentos de balcão", permission: "counter:read", description: "Veja os pagamentos recebidos no balcão." },
];

export const SUPERADMIN_NAV_ITEMS: readonly NavItem[] = [
  { href: "/superadmin", label: "Bureaus", group: "Operação" },
  { href: "/superadmin/saques", label: "Saques", group: "Operação" },
  { href: "/superadmin/payouts", label: "Repasses", group: "Operação" },
  { href: "/superadmin/nfse", label: "NFS-e", group: "Operação" },
  { href: "/superadmin/notifications", label: "Notificações", group: "Operação" },
  { href: "/superadmin/products", label: "Produtos", group: "Catálogo" },
  { href: "/superadmin/settings", label: "Visão geral", group: "Configurações" },
  { href: "/superadmin/settings/comissao", label: "Comissão dos Bureaus", group: "Configurações" },
  { href: "/superadmin/settings/repasses", label: "Prazo dos repasses", group: "Configurações" },
  { href: "/superadmin/settings/afiliados", label: "Afiliados", group: "Configurações" },
  { href: "/superadmin/settings/scr", label: "Termo SCR", group: "Configurações" },
  { href: "/superadmin/settings/prompts", label: "Prompts da IA", group: "Configurações" },
];

const SETTINGS_SUBPAGES = ["/settings/catalog", "/settings/cupons", "/settings/wallet", "/settings/counter-payments", "/settings/payouts"];

// Carteira também cobre as rotas antigas de repasses e balcão, que agora são abas dela.
const WALLET_ROUTES = ["/settings/wallet", "/settings/counter-payments", "/settings/payouts"];

export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === href;
  // Bureaus cobre cadastro e detalhe. A visão geral das configurações não cobre as subpáginas, que têm item próprio.
  if (href === "/superadmin") return pathname === href || pathname.startsWith("/superadmin/bureaus");
  if (href === "/superadmin/settings") return pathname === href;
  if (href === "/settings" && SETTINGS_SUBPAGES.some((sub) => pathname.startsWith(sub))) return false;
  if (href === "/settings/wallet") return WALLET_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  return pathname === href || pathname.startsWith(`${href}/`);
}
