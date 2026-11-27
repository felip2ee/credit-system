"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { voidCounterPaymentAction } from "@/actions/counter-payments";
import { METHOD_LABEL } from "@/components/counter-payments/CounterPaymentForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils";
import type { COUNTER_METHODS } from "@/lib/validators/counter-payments";

export interface CounterPaymentRow {
  id: string;
  method: (typeof COUNTER_METHODS)[number];
  amount: string;
  receivedAt: Date;
  note: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

// A data de recebimento é só data (meia-noite UTC): formatar em UTC evita mostrar o dia anterior.
const dateFormat = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeZone: "UTC",
});

interface CounterPaymentListProps {
  payments: CounterPaymentRow[];
  canWrite: boolean;
}

export function CounterPaymentList({
  payments,
  canWrite,
}: CounterPaymentListProps) {
  const router = useRouter();
  const [voiding, setVoiding] = useState<CounterPaymentRow | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const cancel = () => {
    setVoiding(null);
    setReason("");
    setError(null);
  };

  const confirmVoid = (event: React.FormEvent) => {
    event.preventDefault();
    if (!voiding) return;
    if (reason.trim() === "") {
      setError("Informe o motivo da anulação.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await voidCounterPaymentAction({ id: voiding.id, reason });
      if (res.error) {
        setError(res.error);
        return;
      }
      cancel();
      router.refresh();
    });
  };

  const voidButton = (p: CounterPaymentRow) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-11 md:min-h-0"
      onClick={() => {
        cancel();
        setVoiding(p);
      }}
      disabled={isPending}
      aria-label={`Anular pagamento de ${dateFormat.format(new Date(p.receivedAt))}, ${formatCurrency(Number(p.amount))}`}
    >
      Anular
    </Button>
  );

  const statusOf = (p: CounterPaymentRow) =>
    p.voidedAt ? (
      <span className="space-y-1">
        <Badge variant="secondary">Anulado</Badge>
        {p.voidReason && (
          <span className="block text-sm text-muted-foreground">
            {p.voidReason}
          </span>
        )}
      </span>
    ) : (
      <Badge variant="outline">Válido</Badge>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pagamentos registrados</CardTitle>
      </CardHeader>
      <CardContent>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum pagamento de balcão neste Dossiê.
          </p>
        ) : (
          <>
            <ul className="divide-y rounded-card border md:hidden">
              {payments.map((p) => (
                <li key={p.id} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p
                        className={
                          p.voidedAt ? "font-bold line-through" : "font-bold"
                        }
                      >
                        {formatCurrency(Number(p.amount))}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {dateFormat.format(new Date(p.receivedAt))} ·{" "}
                        {METHOD_LABEL[p.method]}
                      </p>
                    </div>
                    {statusOf(p)}
                  </div>
                  {p.note && (
                    <p className="text-sm text-muted-foreground">{p.note}</p>
                  )}
                  {canWrite && !p.voidedAt && voidButton(p)}
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Forma</TableHead>
                    <TableHead>Valor</TableHead>
                    <TableHead>Observação</TableHead>
                    <TableHead>Situação</TableHead>
                    {canWrite && (
                      <TableHead className="text-right">Ações</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        {dateFormat.format(new Date(p.receivedAt))}
                      </TableCell>
                      <TableCell>{METHOD_LABEL[p.method]}</TableCell>
                      <TableCell
                        className={p.voidedAt ? "line-through" : undefined}
                      >
                        {formatCurrency(Number(p.amount))}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.note ?? "—"}
                      </TableCell>
                      <TableCell>{statusOf(p)}</TableCell>
                      {canWrite && (
                        <TableCell className="text-right">
                          {!p.voidedAt && voidButton(p)}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        {canWrite && (
          <Dialog
            open={voiding !== null}
            onClose={cancel}
            title="Anular pagamento"
            dismissible={!isPending}
          >
            {voiding && (
              <form onSubmit={confirmVoid} noValidate className="space-y-4">
                <p className="rounded-md bg-accent p-3 text-sm">
                  {dateFormat.format(new Date(voiding.receivedAt))} ·{" "}
                  {METHOD_LABEL[voiding.method]} ·{" "}
                  <strong>{formatCurrency(Number(voiding.amount))}</strong>
                </p>
                <div className="space-y-2">
                  <Label htmlFor="cp-void-reason">Motivo da anulação</Label>
                  <Input
                    id="cp-void-reason"
                    autoFocus
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={isPending}
                    aria-invalid={error !== null}
                    aria-describedby={error ? "cp-void-error" : undefined}
                  />
                  {error && (
                    <p
                      id="cp-void-error"
                      role="alert"
                      className="text-sm text-destructive"
                    >
                      {error}
                    </p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={cancel}
                    disabled={isPending}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={isPending || reason.trim() === ""}
                  >
                    {isPending ? "Anulando..." : "Confirmar anulação"}
                  </Button>
                </div>
              </form>
            )}
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
