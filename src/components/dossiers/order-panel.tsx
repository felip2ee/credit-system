"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  cancelOrderAction,
  releaseOrderAction,
  runOrderNowAction,
  type ActionResult,
} from "@/actions/orders";
import { OrderContactDialogList, type PendingContact } from "@/components/dossiers/order-contact-dialog";
import { orderNowText } from "@/components/dossiers/order-now";
import { RevokeOrderDialog } from "@/components/dossiers/revoke-order-dialog";
import { OrderStateBadge } from "@/components/dossiers/order-state-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { ORDER_REASON_LABEL } from "@/lib/orders/labels";
import type { StaffOrderView } from "@/lib/orders/staff-queries";
import type { OrderState } from "@/lib/orders/types";
import { formatCurrency, formatDateTime } from "@/lib/utils";

const AUTH_PENDING: OrderState[] = ["awaiting_payment", "awaiting_authorization"];
const CANCELLABLE: OrderState[] = ["awaiting_payment", "awaiting_authorization", "ready"];

interface OrderPanelProps {
  order: StaffOrderView;
  canWrite: boolean;
  canRegisterPayment: boolean;
  // Membros com autorização pendente (e-mail já mascarado).
  pendingContacts?: PendingContact[];
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

// A consequência vem antes do botão que muda o estado.
function ActionWithEffect({ effect, children }: { effect: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-muted-foreground">{effect}</p>
      {children}
    </div>
  );
}

export function OrderPanel({ order, canWrite, canRegisterPayment, pendingContacts = [] }: OrderPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const run = (action: (id: string) => Promise<ActionResult>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const res = await action(order.dossierId);
      if (res.error) {
        setError(res.error);
        return;
      }
      after?.();
      router.refresh();
    });
  };

  const { state } = order;
  const canRelease = state === "completed" && order.mode === "counter" && order.aiStatus !== "pending";

  const now = orderNowText({ state, mode: order.mode, aiStatus: order.aiStatus, canRegisterPayment });
  const actionClass = "w-full sm:w-auto";

  return (
    <>
      <section aria-labelledby="order-now-title" className="rounded-card border-2 border-primary bg-accent p-4">
        <h2 id="order-now-title" className="text-sm font-bold text-muted-foreground">
          O que acontece agora
        </h2>
        <p className="mt-1 break-words text-base font-bold">{now}</p>
      </section>
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Pedido
          <OrderStateBadge state={state} />
          {order.reason && <span className="text-sm font-normal text-muted-foreground">{ORDER_REASON_LABEL[order.reason]}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Comprador">{order.buyerName ?? "Sem comprador: a entrega fica com a equipe"}</Field>
          <Field label="Preço">{formatCurrency(Number(order.price))}</Field>
          {order.paidTotal !== null && <Field label="Pago no balcão">{formatCurrency(Number(order.paidTotal))}</Field>}
          {order.releasedAt && <Field label="Liberada em">{formatDateTime(order.releasedAt)}</Field>}
          {order.revokedAt && (
            <Field label="Revogada em">
              {formatDateTime(order.revokedAt)}
              {order.revokeReason && <span className="block font-normal text-muted-foreground">{order.revokeReason}</span>}
            </Field>
          )}
        </div>

        {canWrite && (
          <div className="space-y-3">
            {state === "awaiting_payment" && canRegisterPayment && (
              <ActionWithEffect effect="Abre a tela de pagamentos do balcão. Depois de quitar, o pedido segue para a autorização.">
                <Button asChild className={actionClass}>
                  <Link href={`/settings/counter-payments?dossier=${order.dossierId}`}>Registrar pagamento</Link>
                </Button>
              </ActionWithEffect>
            )}
            {state === "ready" && (
              <ActionWithEffect effect="Inicia a consulta agora, sem esperar a fila.">
                <Button className={actionClass} onClick={() => run(runOrderNowAction)} disabled={isPending}>
                  {isPending ? "Executando..." : "Executar agora"}
                </Button>
              </ActionWithEffect>
            )}
            {canRelease && (
              <ActionWithEffect effect="O cliente passa a ver o resultado da pesquisa.">
                <Button className={actionClass} onClick={() => run(releaseOrderAction)} disabled={isPending}>
                  {isPending ? "Liberando..." : "Liberar ao cliente"}
                </Button>
              </ActionWithEffect>
            )}
            {state === "released" && (
              <ActionWithEffect effect="O cliente perde o acesso ao resultado. Você informa o motivo na próxima tela.">
                <Button variant="outline" className={actionClass} onClick={() => setRevoking(true)} disabled={isPending}>
                  Revogar
                </Button>
              </ActionWithEffect>
            )}
            {CANCELLABLE.includes(state) && (
              <ActionWithEffect effect="Encerra o pedido e libera a reserva do pagamento. Não dá para desfazer.">
                <Button variant="outline" className={actionClass} onClick={() => setConfirmingCancel(true)} disabled={isPending}>
                  Cancelar pedido
                </Button>
              </ActionWithEffect>
            )}
          </div>
        )}

        {canWrite && AUTH_PENDING.includes(state) && pendingContacts.length > 0 && (
          <OrderContactDialogList dossierId={order.dossierId} contacts={pendingContacts} canResend={state === "awaiting_authorization"} />
        )}

        <div aria-live="polite">{error && <p className="text-sm text-destructive">{error}</p>}</div>
      </CardContent>

      <Dialog
        open={confirmingCancel}
        onClose={() => setConfirmingCancel(false)}
        title="Cancelar pedido"
        role="alertdialog"
        dismissible={!isPending}
      >
        <p className="text-sm text-muted-foreground">
          O pedido será cancelado e a reserva do pagamento liberada. Esta ação não pode ser desfeita.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmingCancel(false)} disabled={isPending}>
            Voltar
          </Button>
          <Button variant="destructive" onClick={() => run(cancelOrderAction, () => setConfirmingCancel(false))} disabled={isPending}>
            {isPending ? "Cancelando..." : "Cancelar pedido"}
          </Button>
        </div>
      </Dialog>
      <RevokeOrderDialog dossierId={order.dossierId} open={revoking} onClose={() => setRevoking(false)} />
    </Card>
    </>
  );
}
