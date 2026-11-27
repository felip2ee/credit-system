// Única máscara de walletId: só os 4 últimos caracteres. O SQL usa a mesma forma ('***' || right(wallet, 4)).
const VISIBLE_SUFFIX = 4;

export function maskWalletId(walletId: string): string {
	return `***${walletId.slice(-VISIBLE_SUFFIX)}`;
}
