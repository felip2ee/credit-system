import { formatCurrency } from "@/lib/utils";

// O ícone é uma chave: o layout (servidor) não pode passar o componente do ícone a um componente de cliente.
export type PortalNavIcon = "home" | "search" | "credits" | "account";
export type PortalNavItem = { href: string; label: string; icon: PortalNavIcon };

// Afiliação não entra na barra: fica em Conta e como cartão na Início.
export function portalNavItems(permissions: { credits: boolean; affiliates: boolean }): PortalNavItem[] {
	const items: PortalNavItem[] = [
		{ href: "/portal", label: "Início", icon: "home" },
		{ href: "/portal/pesquisas", label: "Pesquisas", icon: "search" },
		{ href: "/portal/perfil", label: "Conta", icon: "account" },
	];
	if (permissions.credits) items.splice(2, 0, { href: "/portal/credits", label: "Créditos", icon: "credits" });
	return items;
}

// Saldo do cabeçalho: só com credits:read e carteira existente; senão o cabeçalho não mostra saldo.
export function headerBalance(canReadCredits: boolean, wallet: { available: string } | null): string | null {
	if (!canReadCredits || !wallet) return null;
	return formatCurrency(Number(wallet.available));
}
