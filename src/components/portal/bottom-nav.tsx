"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

import type { PortalNavItem } from "./nav-items";

function isActive(pathname: string, href: string): boolean {
	return href === "/portal" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

// Celular: barra fixa embaixo, ícone + texto, alvos de 64 px.
export function BottomNav({ items }: { items: PortalNavItem[] }) {
	const pathname = usePathname() ?? "";
	return (
		<nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-40 border-t-2 bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
			<ul className="mx-auto flex max-w-3xl">
				{items.map(({ href, label, icon: Icon }) => {
					const active = isActive(pathname, href);
					return (
						<li key={href} className="flex-1">
							<Link
								href={href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
									active ? "font-bold text-primary" : "text-foreground",
								)}
							>
								<Icon aria-hidden className="size-6" />
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
				{items.map(({ href, label, icon: Icon }) => {
					const active = isActive(pathname, href);
					return (
						<li key={href}>
							<Link
								href={href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"inline-flex min-h-12 items-center gap-2 rounded-md px-3 text-base hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									active ? "font-bold text-primary underline underline-offset-8" : "text-foreground",
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
