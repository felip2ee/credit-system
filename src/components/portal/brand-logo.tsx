import { BRAND_ASSETS, BRAND_NAME } from "@/lib/brand/brand";
import { cn } from "@/lib/utils";

// SVG estático do kit: <img> simples evita o otimizador de imagens, que não altera SVG.
// tone="light": logo branca (filtro CSS) para fundo verde.
export function BrandLogo({ variant, tone = "brand", className }: { variant: "full" | "symbol"; tone?: "brand" | "light"; className?: string }) {
	const full = variant === "full";
	return (
		// eslint-disable-next-line @next/next/no-img-element
		<img
			src={full ? BRAND_ASSETS.logo : BRAND_ASSETS.symbol}
			alt={BRAND_NAME}
			className={cn("w-auto", full ? "h-14" : "h-10", tone === "light" && "brightness-0 invert", className)}
		/>
	);
}
