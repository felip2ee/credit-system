import { BrandLogo } from "./brand-logo";
import { Toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

// Casca das páginas públicas: logo completa no topo, nome do Bureau e uma coluna.
// O nome do Bureau quebra de linha (sem cortar) e nunca invade a logo.
export function PublicShell({
	bureauName,
	width = "md",
	children,
}: {
	bureauName?: string;
	width?: "md" | "3xl";
	children?: React.ReactNode;
}) {
	return (
		<main className="area-portal min-h-screen bg-muted/30 px-4 py-8">
			<div className={cn("mx-auto w-full space-y-6", width === "md" ? "max-w-md" : "max-w-3xl")}>
				<header className="flex flex-col items-center gap-3 text-center">
					<BrandLogo variant="full" />
					{bureauName && <p className="max-w-full break-words text-balance text-xl font-bold">{bureauName}</p>}
				</header>
				{children}
			</div>
			<Toaster />
		</main>
	);
}
