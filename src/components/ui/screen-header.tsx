import Link from "next/link";
import { ArrowLeft, X } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ScreenHeaderProps {
	title: string;
	onBack?: () => void;
	backHref?: string;
	backLabel?: string;
	closeHref?: string;
	onClose?: () => void;
	closeLabel?: string;
	step?: { current: number; total: number; label: string };
	// Ex.: margem negativa para sangrar até a borda quando a tela tem gutter.
	className?: string;
}

// Alvo de 44 px; o foco visível vem do anel padrão.
const ICON_LINK =
	"inline-flex size-11 shrink-0 items-center justify-center rounded-full text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-5";

interface IconActionProps {
	label: string;
	href?: string;
	onClick?: () => void;
	children: React.ReactNode;
}

function IconAction({ label, href, onClick, children }: IconActionProps) {
	if (href) {
		return (
			<Link href={href} aria-label={label} className={ICON_LINK}>
				{children}
			</Link>
		);
	}
	return (
		<button type="button" aria-label={label} onClick={onClick} className={ICON_LINK}>
			{children}
		</button>
	);
}

// Cabeçalho fixo de tela cheia: voltar à esquerda, fechar à direita e, em fluxo por etapas, "Passo N de M".
export function ScreenHeader({ title, onBack, backHref, backLabel = "Voltar", closeHref, onClose, closeLabel = "Fechar", step, className }: ScreenHeaderProps) {
	const hasBack = Boolean(onBack || backHref);
	const hasClose = Boolean(onClose || closeHref);
	return (
		<header data-screen-header className={cn("sticky top-0 z-30 border-b border-border bg-background pt-[env(safe-area-inset-top)]", className)}>
			<div className="flex min-h-11 items-center gap-1">
				{hasBack ? (
					<IconAction label={backLabel} href={backHref} onClick={onBack}>
						<ArrowLeft aria-hidden />
					</IconAction>
				) : (
					<span aria-hidden className="size-11 shrink-0" />
				)}
				<div className="min-w-0 flex-1 text-center">
					<h1 className="text-base font-bold [overflow-wrap:anywhere]">{title}</h1>
					{step && (
						<p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
							Passo {step.current} de {step.total}: {step.label}
						</p>
					)}
				</div>
				{hasClose ? (
					<IconAction label={closeLabel} href={closeHref} onClick={onClose}>
						<X aria-hidden />
					</IconAction>
				) : (
					<span aria-hidden className="size-11 shrink-0" />
				)}
			</div>
			{step && (
				<div aria-hidden className="h-1 bg-muted">
					<div
						className="h-full bg-primary motion-safe:transition-[width] motion-safe:duration-300"
						style={{ width: `${(step.current / step.total) * 100}%` }}
					/>
				</div>
			)}
		</header>
	);
}
