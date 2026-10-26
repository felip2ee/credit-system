// Validação comum dos cursores de paginação da Carteira: "<instante>|<uuid>". Nada inválido chega ao Postgres.
export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_PATTERN}$`, "i");

// Aceita o texto do Postgres ("2026-10-10 12:00:00.1+00") e o ISO. Date.parse rola dia 30/02 para março: confere o dia também.
function isRealInstant(at: string): boolean {
	const iso = at.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
	if (Number.isNaN(Date.parse(iso))) return false;
	const [y, m, d] = at.slice(0, 10).split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

export function assertCursor(at: string, id: string): void {
	if (!UUID.test(id) || !isRealInstant(at)) throw new RangeError("Cursor inválido.");
}
