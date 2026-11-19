// Mensagens pt-BR dos motivos de negócio do pedido. Fora dos arquivos "use server", que só exportam funções async.
export const ORDER_FAILED = "Não foi possível concluir. Tente novamente.";

const SHARED_MESSAGES: Record<string, string> = {
	product_not_for_sale: "Produto indisponível neste Bureau.",
	kind_mismatch: "O documento não combina com o produto.",
	self_holder_missing: "Sua conta não tem Titular. Fale com o Bureau.",
	contact_is_buyer: "Informe o e-mail e o celular do titular, não os seus.",
	buyer_not_found: "Cliente comprador não encontrado neste Bureau.",
	too_many_requests: "Este titular já recebeu pedidos de autorização recentes. Tente novamente amanhã.",
	no_buyer: "Este pedido não tem cliente comprador. Entregue o PDF pela equipe.",
	invalid_state: "O pedido mudou de estado. Recarregue a página.",
	not_found: "Pedido não encontrado.",
};

export const CLIENT_ORDER_MESSAGES: Record<string, string> = {
	...SHARED_MESSAGES,
	insufficient_balance: "Saldo insuficiente. Compre créditos para continuar.",
	third_party_not_allowed:
		"No portal, o Dossiê Pessoa Física é só para você. Envie seu link para a outra pessoa consultar na conta dela.",
	price_mismatch: "O preço mudou. Revise e confirme de novo.",
	commission_not_configured: "Vendas indisponíveis no momento. Fale com o Bureau.",
	too_many_orders: "Você atingiu o limite de pedidos de hoje. Tente amanhã.",
	declaration_outdated: "A declaração mudou. Leia e confirme de novo.",
};

export const STAFF_ORDER_MESSAGES: Record<string, string> = {
	...SHARED_MESSAGES,
	insufficient_balance: "Saldo do Bureau insuficiente para reservar o repasse à plataforma. Recarregue a carteira.",
	commission_not_configured: "A comissão do Bureau não está definida. Fale com a plataforma.",
};

// Correção do contato do pedido de autorização (equipe).
export const UPDATE_CONTACT_MESSAGES: Record<string, string> = {
	...STAFF_ORDER_MESSAGES,
	invalid_input: "Contato inválido. Confira o e-mail e o celular.",
	contact_is_buyer: "Informe o e-mail e o celular do titular, não os do comprador.",
	resend_too_soon: "O pedido de autorização acabou de ser enviado. Aguarde 2 minutos para reenviar.",
	invalid_state: "O pedido não aguarda mais a autorização ou não há contato novo para enviar. Recarregue a página.",
	contact_limit_reached: "Esta autorização já teve 5 trocas ou reenvios nas últimas 24 horas. Tente novamente amanhã.",
};
// Pedido em awaiting_payment: o contato fica salvo e a autorização sai depois do pagamento.
export const CONTACT_UPDATED_AWAITING_PAYMENT = "Contato atualizado. A autorização sai depois do pagamento.";
// Pedido em awaiting_authorization: o tick emite de novo a cada rodada (cerca de 1 minuto) enquanto a autorização não tem código.
export const CONTACT_SEND_PENDING =
	"Contato atualizado, mas o envio do pedido de autorização falhou. O sistema tenta enviar de novo em cerca de 1 minuto.";
