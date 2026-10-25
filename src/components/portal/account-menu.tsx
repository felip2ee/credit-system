import Link from "next/link";
import { FileText, HandCoins, LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { Button } from "@/components/ui/button";

// Itens da Conta que não cabem na barra: Afiliação (só com affiliates:read), termos e Sair.
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
				<Link href="/termos">
					<FileText aria-hidden />
					Termos de uso
				</Link>
			</Button>
			<form action={signOut}>
				<Button type="submit" variant="ghost" className="h-14 w-full justify-start rounded-card bg-muted px-4 text-foreground hover:bg-secondary">
					<LogOut aria-hidden />
					Sair
				</Button>
			</form>
		</nav>
	);
}
