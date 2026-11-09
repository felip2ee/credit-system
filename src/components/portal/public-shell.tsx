import { BrandLogo } from "./brand-logo";
import { Toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

// Casca das páginas públicas: faixa verde profundo sólida (logo clara, nome do Bureau pequeno em caixa alta dourada e,
// opcional, o bloco `hero`) e uma coluna de conteúdo. O nome do Bureau quebra de linha (sem cortar) e nunca invade a logo.
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
		<main className="area-portal min-h-screen bg-background">
			<div className="bg-brand-deep px-screen pb-10 pt-8 text-foreground">
				<header className={cn(column, "space-y-6")}>
					<div className="flex flex-col items-center gap-3 text-center">
						<BrandLogo variant="full" tone="light" />
						{bureauName && (
							<p className="max-w-full break-words text-balance text-[11px] font-semibold uppercase leading-none tracking-[0.2em] text-brand-gold">{bureauName}</p>
						)}
					</div>
					{hero}
				</header>
			</div>
			<div className={cn(column, "space-y-6 px-screen py-8")}>{children}</div>
			<Toaster />
		</main>
	);
}
