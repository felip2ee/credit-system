import Link from "next/link";
import { Bell, FileText, HandCoins } from "lucide-react";

import { PortalSignOutButton } from "@/components/portal/sign-out-button";
import { Button } from "@/components/ui/button";

// Itens da Conta que não cabem na barra: Afiliação (só com affiliates:read), Notificações, termos e Sair.
export function AccountMenu({ showAffiliates }: { showAffiliates: boolean }) {
	return (
		<nav aria-label="Conta" className="space-y-2">
			{showAffiliates && (
				<Button asChild variant="ghost" className="h-14 w-full justify-start rounded-card bg-muted px-4 text-foreground hover:bg-secondary">
					<Link href="/portal/afiliacao">
						<HandCoins aria-hidden />
						Afiliação
					</Link>
				</Button>
			)}
			<Button asChild variant="ghost" className="h-14 w-full justify-start rounded-card bg-muted px-4 text-foreground hover:bg-secondary">
				<Link href="/portal/notificacoes">
					<Bell aria-hidden />
					Notificações
				</Link>
			</Button>
			<Button asChild variant="ghost" className="h-14 w-full justify-start rounded-card bg-muted px-4 text-foreground hover:bg-secondary">
				<Link href="/termos">
					<FileText aria-hidden />
					Termos de uso
				</Link>
			</Button>
			<PortalSignOutButton />
		</nav>
	);
}
