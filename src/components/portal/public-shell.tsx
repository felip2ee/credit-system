import { BrandLogo } from "./brand-logo";
import { Toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

// Casca das páginas públicas: faixa verde da marca (logo branca, nome do Bureau em caixa alta e,
// opcional, o bloco `hero`) que desce em degradê até o fundo da página, e uma coluna de conteúdo.
// O nome do Bureau quebra de linha (sem cortar) e nunca invade a logo.
export function PublicShell({
	bureauName,
	hero,
	width = "md",
	children,
}: {
	bureauName?: string;
	hero?: React.ReactNode;
	width?: "md" | "3xl";
	children?: React.ReactNode;
}) {
	const column = cn("mx-auto w-full", width === "md" ? "max-w-md" : "max-w-3xl");
	return (
		<main className="area-portal min-h-screen bg-surface">
			<div className="bg-gradient-to-b from-primary from-75% to-surface px-screen pb-12 pt-8 text-primary-foreground">
				<header className={cn(column, "space-y-6")}>
					<div className="flex flex-col items-center gap-3 text-center">
						<BrandLogo variant="full" tone="light" />
						{bureauName && (
							<p className="max-w-full break-words text-balance text-xl font-bold uppercase tracking-wide">{bureauName}</p>
						)}
					</div>
					{hero}
				</header>
			</div>
			<div className={cn(column, "space-y-6 px-screen pb-8")}>{children}</div>
			<Toaster />
		</main>
	);
}
