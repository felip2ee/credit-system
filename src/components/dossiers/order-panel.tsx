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
import { RevokeOrderDialog } from "@/components/dossiers/revoke-order-dialog";
import { OrderStateBadge } from "@/components/dossiers/order-state-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { ORDER_REASON_LABEL } from "@/lib/orders/labels";
import type { StaffOrderView } from "@/lib/orders/queries";
import type { OrderState } from "@/lib/orders/types";
import { formatCurrency, formatDateTime } from "@/lib/utils";

const AI_STATUS_LABEL = {
  none: null,
  pending: "Parecer IA em andamento",
  done: "Parecer IA pronto",
  failed: "Parecer IA falhou",
} as const;

const CANCELLABLE: OrderState[] = ["awaiting_payment", "awaiting_authorization", "ready"];

interface OrderPanelProps {
  order: StaffOrderView;
  canWrite: boolean;
  canRegisterPayment: boolean;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

export function OrderPanel({ order, canWrite, canRegisterPayment }: OrderPanelProps) {
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
  const aiLabel = order.withAi ? AI_STATUS_LABEL[order.aiStatus] : null;
  const canRelease = state === "completed" && order.mode === "counter" && order.aiStatus !== "pending";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          Pedido
          <OrderStateBadge state={state} />
          {order.reason && <span className="text-sm font-normal text-muted-foreground">{ORDER_REASON_LABEL[order.reason]}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Comprador">{order.buyerName ?? "Sem comprador: a entrega fica com a equipe"}</Field>
          <Field label="Preço">{formatCurrency(Number(order.price))}</Field>
          {order.paidTotal !== null && <Field label="Pago no balcão">{formatCurrency(Number(order.paidTotal))}</Field>}
          {aiLabel && (
            <Field label="Parecer IA">
              <span className={order.aiStatus === "failed" ? "text-destructive" : undefined}>{aiLabel}</span>
            </Field>
          )}
          {order.releasedAt && <Field label="Liberada em">{formatDateTime(order.releasedAt)}</Field>}
          {order.revokedAt && (
            <Field label="Revogada em">
              {formatDateTime(order.revokedAt)}
              {order.revokeReason && <span className="block font-normal text-muted-foreground">{order.revokeReason}</span>}
            </Field>
          )}
        </div>

        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {state === "awaiting_payment" && canRegisterPayment && (
              <Button asChild>
                <Link href={`/settings/counter-payments?dossier=${order.dossierId}`}>Registrar pagamento</Link>
              </Button>
            )}
            {state === "ready" && (
              <Button onClick={() => run(runOrderNowAction)} disabled={isPending}>
                {isPending ? "Executando..." : "Executar agora"}
              </Button>
            )}
            {canRelease && (
              <Button onClick={() => run(releaseOrderAction)} disabled={isPending}>
                {isPending ? "Liberando..." : "Liberar ao cliente"}
              </Button>
            )}
            {state === "released" && (
              <Button variant="outline" onClick={() => setRevoking(true)} disabled={isPending}>
                Revogar
              </Button>
            )}
            {CANCELLABLE.includes(state) && (
              <Button variant="outline" onClick={() => setConfirmingCancel(true)} disabled={isPending}>
                Cancelar pedido
              </Button>
            )}
          </div>
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
  );
}
