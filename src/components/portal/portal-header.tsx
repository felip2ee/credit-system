import Link from "next/link";

import { BrandLogo } from "./brand-logo";
import { InlineNav } from "./bottom-nav";
import type { PortalNavItem } from "./nav-items";

// balance = null (sem credits:read ou sem carteira): o cabeçalho não mostra saldo.
export function PortalHeader({ items, balance }: { items: PortalNavItem[]; balance: string | null }) {
	return (
		<header className="border-b-2 bg-background">
			<div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-2 md:max-w-5xl">
				<Link href="/portal" aria-label="Rainha Cred, página inicial" className="flex min-h-12 min-w-12 shrink-0 items-center">
					<BrandLogo variant="symbol" className="md:hidden" />
					<BrandLogo variant="full" className="hidden md:block" />
				</Link>
				<span className="text-lg font-bold md:hidden">Rainha Cred</span>
				<InlineNav items={items} />
				{balance && (
					<Link href="/portal/credits" className="flex min-h-12 flex-col justify-center rounded-md border-2 px-3 text-right leading-tight">
						<span className="text-base">Saldo</span>
						<span className="text-lg font-bold">{balance}</span>
					</Link>
				)}
			</div>
		</header>
	);
}
