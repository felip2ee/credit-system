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

// Celular: barra fixa embaixo. Item ativo = círculo verde com ícone branco; o rótulo fica sempre visível.
export function BottomNav({ items }: { items: PortalNavItem[] }) {
	const pathname = usePathname() ?? "";
	return (
		<nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-40 rounded-t-hero border-t border-border bg-background pb-[env(safe-area-inset-bottom)] shadow-lg md:hidden">
			<ul className="mx-auto flex max-w-3xl">
				{items.map(({ href, label, icon }) => {
					const Icon = ICONS[icon];
					const active = isActive(pathname, href);
					return (
						<li key={href} className="flex-1">
							<Link
								href={href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"flex min-h-[72px] flex-col items-center justify-center gap-1 px-1 py-1 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
									active ? "font-bold text-primary" : "text-muted-foreground",
								)}
							>
								<span
									className={cn(
										"flex size-11 items-center justify-center rounded-full transition-colors",
										active && "bg-primary text-primary-foreground",
									)}
								>
									<Icon aria-hidden className="size-6" />
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
									"inline-flex min-h-12 items-center gap-2 rounded-full px-4 text-base hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
