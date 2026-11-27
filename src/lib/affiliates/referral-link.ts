// Mantém o código do link de afiliado (?ref=) ao navegar entre entrar e cadastro. O servidor valida o código no cadastro.
export function withReferral(href: string, ref: string | string[] | undefined | null): string {
	return typeof ref === "string" && ref ? `${href}?ref=${encodeURIComponent(ref)}` : href;
}
