import { ORDER_REASON_LABEL } from "@/lib/orders/labels";
import { PAYMENT_WINDOW_DAYS, SCR_REQUEST_DAYS, type AiStatus, type OrderMode, type OrderState, type OrderStateReason } from "@/lib/orders/types";

interface OrderNowInput {
  state: OrderState;
  mode: OrderMode;
  aiStatus: AiStatus;
  reason: OrderStateReason | null;
  // Quem vê a tela pode agir (falso em sessão de suporte).
  canWrite: boolean;
  canRegisterPayment: boolean;
  hasBuyer: boolean;
  hasPartners: boolean;
  revoked: boolean;
}

// A autorização falhou antes de a consulta começar.
const NEVER_STARTED: OrderStateReason[] = ["scr_refused", "scr_expired"];

const withoutFinalDot = (text: string) => text.replace(/\.$/, "");

// Sem cliente o servidor recusa a liberação (no_buyer); o pedido online é liberado pelo tick.
export function canReleaseOrder({ state, mode, aiStatus, hasBuyer }: Pick<OrderNowInput, "state" | "mode" | "aiStatus" | "hasBuyer">): boolean {
  return state === "completed" && mode === "counter" && aiStatus !== "pending" && hasBuyer;
}

function paymentText({ mode, canWrite, canRegisterPayment }: OrderNowInput): string {
  if (mode !== "counter") return "Esperando o pagamento do cliente. O pedido segue quando ele for confirmado.";
  const quem =
    canWrite && canRegisterPayment
      ? "Registre o pagamento para o pedido seguir."
      : "Quem tem acesso ao balcão precisa registrá-lo.";
  return `Esperando o pagamento. ${quem} A autorização só é solicitada depois do pagamento. Sem o pagamento completo em ${PAYMENT_WINDOW_DAYS} dias após a abertura, o pedido é cancelado.`;
}

function authorizationText(hasPartners: boolean): string {
  return hasPartners
    ? `Esperando a autorização SCR do titular e de todos os sócios. Se algum pedido de autorização ficar ${SCR_REQUEST_DAYS} dias sem resposta, o pedido vence.`
    : `Esperando o titular autorizar a consulta SCR. Sem resposta em ${SCR_REQUEST_DAYS} dias, o pedido vence.`;
}

function completedText({ mode, aiStatus, hasBuyer, revoked }: OrderNowInput): string {
  const pending = aiStatus === "pending";
  if (!hasBuyer) {
    const parecer = pending ? " O parecer ainda está sendo gerado." : "";
    return `A consulta terminou.${parecer} Este pedido não tem cliente: entregue o PDF pela equipe.`;
  }
  if (mode === "counter") {
    return pending
      ? "A consulta terminou. O parecer ainda está sendo gerado: libere ao cliente quando ele ficar pronto."
      : "A consulta terminou. Falta liberar o resultado ao cliente.";
  }
  if (revoked) {
    return "A consulta terminou e a liberação foi revogada. O sistema não libera este resultado de novo sozinho, e esta tela não permite liberá-lo.";
  }
  return pending
    ? "A consulta terminou. O parecer ainda está sendo gerado: o sistema libera o resultado ao cliente quando a geração terminar."
    : "A consulta terminou. O sistema libera o resultado ao cliente automaticamente. Nada a fazer.";
}

function failedText(reason: OrderStateReason | null): string {
  if (!reason) return "A consulta não terminou.";
  const motivo = `Motivo: ${withoutFinalDot(ORDER_REASON_LABEL[reason])}.`;
  return NEVER_STARTED.includes(reason) ? `A consulta não chegou a começar. ${motivo}` : `A consulta não terminou. ${motivo}`;
}

// Linha "o que acontece agora" do pedido, para a equipe do Bureau. Diz o estado e o que fazer (ou que nada falta).
export function orderNowText(input: OrderNowInput): string {
  const { state, reason } = input;
  switch (state) {
    case "awaiting_payment":
      return paymentText(input);
    case "awaiting_authorization":
      return authorizationText(input.hasPartners);
    case "ready":
      return "Na fila. A consulta começa em instantes ou na próxima tentativa agendada.";
    case "executing":
      return "A consulta está em andamento. Atualize a tela para ver o resultado.";
    case "completed":
      return completedText(input);
    case "released":
      return "O resultado já está com o cliente. Nada a fazer.";
    case "failed":
      return failedText(reason);
    case "cancelled":
      return reason ? `Pedido encerrado. Motivo: ${withoutFinalDot(ORDER_REASON_LABEL[reason])}. Nada a fazer.` : "Pedido encerrado. Nada a fazer.";
    default:
      return "Situação desconhecida. Fale com o suporte.";
  }
}
