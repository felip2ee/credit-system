import Link from "next/link";

import { BalanceChip } from "./balance-chip";
import { BrandLogo } from "./brand-logo";
import { InlineNav } from "./bottom-nav";
import type { PortalNavItem } from "./nav-items";

// balance = null (sem credits:read ou sem carteira): o cabeçalho não mostra saldo.
export function PortalHeader({ items, balance }: { items: PortalNavItem[]; balance: string | null }) {
	return (
		// z-20: a tela com ScreenHeader (z-30) cobre este cabeçalho ao rolar, sem duas barras sobrepostas.
		<header className="sticky top-0 z-20 border-b border-border bg-background pt-[env(safe-area-inset-top)]">
			<div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-screen py-1 md:max-w-5xl">
				<Link href="/portal" aria-label="Rainha Cred, página inicial" className="flex min-h-11 min-w-11 shrink-0 items-center">
					<BrandLogo variant="symbol" tone="light" className="md:hidden" />
					<BrandLogo variant="full" tone="light" className="hidden md:block" />
				</Link>
				<InlineNav items={items} />
				{balance && <BalanceChip value={balance} />}
			</div>
		</header>
	);
}
