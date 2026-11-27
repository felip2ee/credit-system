import type { AiStatus, OrderMode, OrderState } from "@/lib/orders/types";

interface OrderNowInput {
  state: OrderState;
  mode: OrderMode;
  aiStatus: AiStatus;
  canRegisterPayment: boolean;
}

// Linha "o que acontece agora" do pedido, para a equipe do Bureau. Diz o estado e o que fazer (ou que nada falta).
export function orderNowText({ state, mode, aiStatus, canRegisterPayment }: OrderNowInput): string {
  switch (state) {
    case "awaiting_payment":
      return canRegisterPayment
        ? "Esperando o pagamento. Registre o pagamento para o pedido seguir."
        : "Esperando o pagamento. O pedido segue sozinho quando ele for confirmado.";
    case "awaiting_authorization":
      return "Esperando o titular autorizar a consulta SCR. Sem resposta em 7 dias, o pedido vence.";
    case "ready":
      return "A consulta começa em instantes. Você pode iniciar agora.";
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
      return "A consulta não terminou. Veja o motivo abaixo.";
    case "cancelled":
      return "Pedido encerrado. Nada a fazer.";
    default:
      return "Situação desconhecida. Fale com o suporte.";
  }
}
