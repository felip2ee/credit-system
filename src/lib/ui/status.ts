import type { StateTone } from "@/components/ui/state-tone";

export type StatusDomain =
	| "order"
	| "orderReason"
	| "consultation"
	| "scr"
	| "member"
	| "withdrawal"
	| "commission"
	| "asaasCommission"
	| "walletEntry"
	| "payment";

export type StatusInfo = { tone: StateTone; label: string; explanation: string; nextStep: string | null };
type Entry = [tone: StateTone, label: string, explanation: string, nextStep?: string];

const FAILED = "Não foi possível consultar";
const CANCELLED = "Cancelado";

const TABLE: Record<StatusDomain, Record<string, Entry>> = {
	order: {
		awaiting_payment: ["waiting", "Aguardando pagamento", "Esperamos a confirmação do pagamento.", "Conclua o pagamento."],
		awaiting_authorization: [
			"waiting",
			"Aguardando autorização",
			"O titular precisa autorizar a consulta. O pedido vence em 7 dias sem resposta.",
			"Peça ao titular que confirme a autorização.",
		],
		ready: ["progress", "Na fila", "A consulta vai começar em instantes."],
		executing: ["progress", "Em consulta", "Estamos fazendo a consulta."],
		completed: [
			"waiting",
			"Pronto, aguardando liberação do Bureau",
			"A consulta terminou. O Bureau ainda vai liberar o resultado.",
		],
		released: ["success", "Pronto para ver", "O resultado está liberado."],
		failed: ["attention", FAILED, "A consulta não terminou.", "Veja o motivo e tente de novo."],
		cancelled: ["neutral", CANCELLED, "Este pedido foi encerrado."],
	},
	orderReason: {
		scr_refused: ["attention", FAILED, "A autorização foi recusada."],
		scr_expired: ["neutral", "Autorização vencida", "A autorização venceu."],
		payment_timeout: ["neutral", CANCELLED, "Pagamento não recebido no prazo"],
		cancelled_by_staff: ["neutral", CANCELLED, "Cancelada pela equipe"],
		cancelled_by_client: ["neutral", CANCELLED, "Cancelada pelo cliente"],
		deps_no_data: ["attention", FAILED, "Não encontramos dados para este documento."],
		deps_incompatible: ["attention", FAILED, "Não conseguimos ler a resposta da consulta."],
		deps_unavailable: ["attention", FAILED, "O serviço de consulta está fora do ar."],
		reservation_clawed_back: ["neutral", "Pagamento estornado", "Pagamento estornado"],
		payment_not_reserved: ["neutral", CANCELLED, "Pagamento recebido como saldo"],
		payment_refunded: ["neutral", CANCELLED, "PIX estornado"],
	},
	consultation: {
		pending_authorization: ["waiting", "Aguardando autorização", "Esperamos a autorização do titular.", "Peça ao titular que autorize."],
		authorized: ["success", "Autorizado", "O titular autorizou a consulta."],
		processing: ["progress", "Em consulta", "Estamos fazendo a consulta."],
		completed: ["success", "Pronto para ver", "O resultado está pronto."],
		payload_incompatible: ["attention", FAILED, "Não conseguimos ler a resposta da consulta.", "Tente de novo mais tarde."],
		error: ["attention", FAILED, "A consulta não terminou.", "Tente de novo mais tarde."],
		rejected: ["attention", "Recusado", "O titular recusou a autorização."],
	},
	scr: {
		pending: ["waiting", "Aguardando autorização", "Esperamos o titular autorizar.", "Peça ao titular que autorize."],
		authorized: ["success", "Autorizado", "O titular autorizou a consulta."],
		not_authorized: ["attention", "Não autorizado", "O titular não autorizou a consulta."],
		expired: ["neutral", "Vencido", "A autorização venceu."],
	},
	member: {
		pending: ["waiting", "Aguardando autorização", "Esperamos esta pessoa autorizar.", "Peça a ela que autorize."],
		authorized: ["success", "Autorizado", "Esta pessoa autorizou a consulta."],
		refused: ["attention", "Recusado", "Esta pessoa recusou a autorização."],
		expired: ["neutral", "Vencido", "A autorização venceu."],
	},
	withdrawal: {
		open: ["waiting", "Em análise", "Estamos preparando o pagamento deste saque."],
		paid: ["success", "Pago", "O saque foi pago."],
		cancelled: ["neutral", CANCELLED, "Este saque foi cancelado."],
	},
	commission: {
		pending: ["waiting", "A liberar", "A comissão ainda está no prazo de liberação."],
		released: ["success", "Liberada", "A comissão está no seu saldo."],
		reversed: ["neutral", "Desfeita", "A comissão foi desfeita."],
	},
	asaasCommission: {
		pending: ["waiting", "Aguardando o Asaas", "O Asaas ainda não confirmou o repasse."],
		done: ["success", "Pago na conta Asaas", "A comissão foi paga na sua conta Asaas."],
		refused: ["attention", "Recusado pelo Asaas", "O Asaas não fez o repasse desta comissão."],
		refunded: ["neutral", "Recarga estornada", "A recarga foi devolvida. A comissão foi desfeita."],
		reversal_failed: [
			"attention",
			"Recarga estornada, reversão pendente",
			"A recarga foi devolvida e o Asaas ainda não desfez o repasse.",
		],
	},
	payment: {
		paid: ["success", "Pago", "O pagamento foi recebido."],
		awaiting: ["waiting", "Aguardando pagamento", "Ainda falta receber o pagamento."],
		cancelled: ["neutral", CANCELLED, "Este pedido foi cancelado."],
		refunded: ["neutral", "Devolvido", "O valor voltou para o saldo do cliente."],
	},
	walletEntry: {
		topup: ["success", "Recarga", "Entrada de saldo."],
		reserve: ["waiting", "Reserva", "Valor guardado para um pedido."],
		capture: ["neutral", "Cobrança", "Valor cobrado de um pedido."],
		release: ["neutral", "Liberação", "Valor reservado que voltou ao saldo."],
		adjustment: ["neutral", "Ajuste", "Ajuste feito pelo Bureau."],
		reversal: ["attention", "Estorno", "Valor devolvido."],
		commission_credit: ["success", "Comissão convertida", "Comissão que virou saldo."],
		adjustment_credit: ["success", "Ajuste do Bureau (crédito)", "O Bureau somou este valor ao seu saldo."],
		adjustment_debit: ["neutral", "Ajuste do Bureau (débito)", "O Bureau tirou este valor do seu saldo."],
		client_adjustment_out: ["neutral", "Crédito a cliente", "Saldo dado a um cliente."],
		client_adjustment_in: ["neutral", "Débito de cliente", "Saldo tirado de um cliente."],
	},
};

const UNKNOWN: StatusInfo = {
	tone: "danger",
	label: "Situação desconhecida",
	explanation: "Não conseguimos mostrar esta situação.",
	nextStep: "Fale com o suporte.",
};

// Fonte única de rótulo, tom e orientação. Status sem entrada vira "Situação desconhecida" (nunca o código).
// A equipe vê o mesmo vocabulário, sem o próximo passo dirigido ao cliente.
// Pedido online concluído: o tick libera sozinho, o Bureau não libera nada (só o balcão espera o Bureau).
// Entrega revogada volta a completed e o tick a ignora: vale o texto padrão, que não promete liberação.
const ONLINE_COMPLETED: Entry = ["progress", "Pronto, liberando o resultado", "A consulta terminou. O sistema libera o resultado automaticamente."];

export function statusInfo(domain: StatusDomain, status: string, audience: "client" | "staff", mode?: "online" | "counter", revoked = false): StatusInfo {
	const rows = TABLE[domain];
	if (!rows || !Object.hasOwn(rows, status)) return UNKNOWN;
	const [tone, label, explanation, nextStep] = domain === "order" && status === "completed" && mode === "online" && !revoked ? ONLINE_COMPLETED : rows[status];
	return { tone, label, explanation, nextStep: audience === "client" ? (nextStep ?? null) : null };
}
