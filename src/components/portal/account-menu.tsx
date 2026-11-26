import Link from "next/link";
import { Bell, ChevronRight, FileText, HandCoins, type LucideIcon } from "lucide-react";

import { PortalSignOutButton } from "@/components/portal/sign-out-button";
import { Button } from "@/components/ui/button";

interface AccountLinkProps {
	href: string;
	icon: LucideIcon;
	label: string;
}

function AccountLink({ href, icon: Icon, label }: AccountLinkProps) {
	return (
		<Button asChild variant="ghost" className="h-14 dense:h-14 w-full justify-start gap-3 rounded-card border border-input bg-card px-3 text-foreground hover:bg-accent hover:text-foreground">
			<Link href={href}>
				<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
					<Icon aria-hidden />
				</span>
				{label}
				<ChevronRight aria-hidden className="ml-auto opacity-60" />
			</Link>
		</Button>
	);
}

// Itens da Conta que não cabem na barra: Afiliação (só com affiliates:read), Notificações, termos e Sair.
export function AccountMenu({ showAffiliates }: { showAffiliates: boolean }) {
	return (
		<nav aria-label="Conta" className="space-y-2">
			{showAffiliates && <AccountLink href="/portal/afiliacao" icon={HandCoins} label="Afiliação" />}
			<AccountLink href="/portal/notificacoes" icon={Bell} label="Notificações" />
			<AccountLink href="/termos" icon={FileText} label="Termos de uso" />
			<PortalSignOutButton />
		</nav>
	);
}
