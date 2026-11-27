import type { OrderState } from "@/lib/orders/types";
import { formatCurrency } from "@/lib/utils";

// "Situação" do pedido de balcão: só pedido em awaiting_payment aceita pagamento, então só nele há valor a cobrar.
export function counterSituation(remainingCents: number | null, orderState: OrderState | null): string {
  if (remainingCents === null) return "Sem liquidação ainda";
  if (remainingCents <= 0) return "Quitado";
  return orderState === "awaiting_payment" ? `Falta ${formatCurrency(remainingCents / 100)}` : "O pedido não aguarda pagamento";
}
