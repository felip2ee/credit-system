// Mensagens pt-BR dos motivos de negócio do pedido. Fora dos arquivos "use server", que só exportam funções async.
export const ORDER_FAILED = "Não foi possível concluir. Tente novamente.";

const SHARED_MESSAGES: Record<string, string> = {
	product_not_for_sale: "Produto indisponível neste Bureau.",
	addon_not_for_sale: "Parecer IA indisponível para este produto.",
	kind_mismatch: "O documento não combina com o produto.",
	self_holder_missing: "Sua conta não tem Titular. Fale com o Bureau.",
	contact_is_buyer: "Informe o e-mail e o celular do titular, não os seus.",
	buyer_not_found: "Cliente comprador não encontrado neste Bureau.",
	no_buyer: "Este pedido não tem cliente comprador. Entregue o PDF pela equipe.",
	invalid_state: "O pedido mudou de estado. Recarregue a página.",
	not_found: "Pedido não encontrado.",
};

export const CLIENT_ORDER_MESSAGES: Record<string, string> = {
	...SHARED_MESSAGES,
	insufficient_balance: "Saldo insuficiente. Compre créditos para continuar.",
};

export const STAFF_ORDER_MESSAGES: Record<string, string> = {
	...SHARED_MESSAGES,
	insufficient_balance: "Saldo do Bureau insuficiente para reservar o custo. Recarregue a carteira.",
};
