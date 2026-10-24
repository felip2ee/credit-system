function channel(value: number): number {
	const v = value / 255;
	return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const n = parseInt(hex.replace("#", ""), 16);
	return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Razão de contraste WCAG 2.x entre duas cores hex (#RRGGBB), de 1 a 21. */
export function contrastRatio(hexA: string, hexB: string): number {
	const [light, dark] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
	return (light + 0.05) / (dark + 0.05);
}
