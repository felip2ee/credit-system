import Link from "next/link";
import { FileText, HandCoins, LogOut } from "lucide-react";

import { signOut } from "@/actions/auth";
import { Button } from "@/components/ui/button";

// Itens da Conta que não cabem na barra: Afiliação (só com affiliates:read), termos e Sair.
export function AccountMenu({ showAffiliates }: { showAffiliates: boolean }) {
	return (
		<nav aria-label="Conta" className="space-y-2">
			{showAffiliates && (
				<Button asChild variant="outline" className="w-full justify-start">
					<Link href="/portal/afiliacao">
						<HandCoins aria-hidden />
						Afiliação
					</Link>
				</Button>
			)}
			<Button asChild variant="outline" className="w-full justify-start">
				<Link href="/termos">
					<FileText aria-hidden />
					Termos de uso
				</Link>
			</Button>
			<form action={signOut}>
				<Button type="submit" variant="outline" className="w-full justify-start">
					<LogOut aria-hidden />
					Sair
				</Button>
			</form>
		</nav>
	);
}
