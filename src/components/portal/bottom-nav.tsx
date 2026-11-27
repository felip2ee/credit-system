"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CreditCard, FileSearch, Home, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";

import type { PortalNavIcon, PortalNavItem } from "./nav-items";

const ICONS = { home: Home, search: FileSearch, credits: CreditCard, account: UserRound } satisfies Record<PortalNavIcon, unknown>;

function isActive(pathname: string, href: string): boolean {
	return href === "/portal" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

// A altura min-h-14 (56 px) também vale em client-order-form.tsx (rodapé fixo do assistente); os dois valores mudam juntos.
// O rótulo cresce com a fonte só até caber numa linha (4,4vw): barra mais alta cobriria o rodapé preso das etapas.
// Celular: barra fixa embaixo. Item ativo = círculo verde com ícone branco; o rótulo fica sempre visível.
export function BottomNav({ items }: { items: PortalNavItem[] }) {
	const pathname = usePathname() ?? "";
	return (
		<nav data-bottom-nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-40 rounded-t-hero border-t border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-lg md:hidden">
			<ul className="mx-auto flex max-w-3xl">
				{items.map(({ href, label, icon }) => {
					const Icon = ICONS[icon];
					const active = isActive(pathname, href);
					return (
						<li key={href} className="min-w-0 flex-1">
							<Link
								href={href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"flex min-h-14 flex-col items-center justify-center gap-0.5 px-0.5 py-1 text-center text-[length:min(0.75rem,4.4vw)] leading-tight [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
									active ? "font-bold text-primary" : "text-muted-foreground",
								)}
							>
								<span
									className={cn(
										"flex h-7 w-12 max-w-full items-center justify-center rounded-full duration-fast ease-out motion-safe:transition-colors",
										active && "bg-primary text-primary-foreground",
									)}
								>
									<Icon aria-hidden className="size-5" />
								</span>
								{label}
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

// Computador: os mesmos itens em linha no cabeçalho.
export function InlineNav({ items }: { items: PortalNavItem[] }) {
	const pathname = usePathname() ?? "";
	return (
		<nav aria-label="Principal" className="hidden md:block">
			<ul className="flex items-center gap-2">
				{items.map(({ href, label, icon }) => {
					const Icon = ICONS[icon];
					const active = isActive(pathname, href);
					return (
						<li key={href}>
							<Link
								href={href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-base duration-fast ease-out hover:bg-accent motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									active ? "bg-brand-soft font-bold text-brand-soft-foreground" : "text-foreground",
								)}
							>
								<Icon aria-hidden className="size-5" />
								{label}
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
