import { ORDER_REASON_LABEL } from "@/lib/orders/labels";
import type { AiStatus, OrderMode, OrderState, OrderStateReason } from "@/lib/orders/types";

interface OrderNowInput {
  state: OrderState;
  mode: OrderMode;
  aiStatus: AiStatus;
  reason: OrderStateReason | null;
  // Quem vê a tela pode agir (falso em sessão de suporte).
  canWrite: boolean;
  canRegisterPayment: boolean;
}

// A autorização falhou antes de a consulta começar.
const NEVER_STARTED: OrderStateReason[] = ["scr_refused", "scr_expired"];

const withoutFinalDot = (text: string) => text.replace(/\.$/, "");

function paymentText({ mode, canWrite, canRegisterPayment }: OrderNowInput): string {
  if (mode !== "counter") return "Esperando o pagamento do cliente. O pedido segue quando ele for confirmado.";
  return canWrite && canRegisterPayment
    ? "Esperando o pagamento. Registre o pagamento para o pedido seguir."
    : "Esperando o pagamento. Quem tem acesso ao balcão precisa registrá-lo.";
}

function failedText(reason: OrderStateReason | null): string {
  if (!reason) return "A consulta não terminou.";
  const motivo = `Motivo: ${withoutFinalDot(ORDER_REASON_LABEL[reason])}.`;
  return NEVER_STARTED.includes(reason) ? `A consulta não chegou a começar. ${motivo}` : `A consulta não terminou. ${motivo}`;
}

// Linha "o que acontece agora" do pedido, para a equipe do Bureau. Diz o estado e o que fazer (ou que nada falta).
export function orderNowText(input: OrderNowInput): string {
  const { state, mode, aiStatus, reason } = input;
  switch (state) {
    case "awaiting_payment":
      return paymentText(input);
    case "awaiting_authorization":
      return "Esperando o titular autorizar a consulta SCR. Sem resposta em 7 dias, o pedido vence.";
    case "ready":
      return "A consulta começa em instantes. Você pode pedir para iniciar agora.";
    case "executing":
      return "A consulta está em andamento. Atualize a tela para ver o resultado.";
    case "completed":
      if (mode !== "counter") return "A consulta terminou. O resultado aguarda a liberação do Bureau.";
      return aiStatus === "pending"
        ? "A consulta terminou. O parecer ainda está sendo gerado: libere ao cliente quando ele ficar pronto."
        : "A consulta terminou. Falta liberar o resultado ao cliente.";
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
