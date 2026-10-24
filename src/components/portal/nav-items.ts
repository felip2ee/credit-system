import { CreditCard, FileSearch, Home, UserRound, type LucideIcon } from "lucide-react";

import { formatCurrency } from "@/lib/utils";

export type PortalNavItem = { href: string; label: string; icon: LucideIcon };

// Afiliação não entra na barra: fica em Conta e como cartão na Início.
export function portalNavItems(permissions: { credits: boolean; affiliates: boolean }): PortalNavItem[] {
	return [
		{ href: "/portal", label: "Início", icon: Home },
		{ href: "/portal/pesquisas", label: "Pesquisas", icon: FileSearch },
		...(permissions.credits ? [{ href: "/portal/credits", label: "Créditos", icon: CreditCard }] : []),
		{ href: "/portal/perfil", label: "Conta", icon: UserRound },
	];
}

// Saldo do cabeçalho: só com credits:read e carteira existente; senão o cabeçalho não mostra saldo.
export function headerBalance(canReadCredits: boolean, wallet: { available: string } | null): string | null {
	if (!canReadCredits || !wallet) return null;
	return formatCurrency(Number(wallet.available));
}
