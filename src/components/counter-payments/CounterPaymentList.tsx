"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { voidCounterPaymentAction } from "@/actions/counter-payments";
import { METHOD_LABEL } from "@/components/counter-payments/CounterPaymentForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "UTC" });

interface CounterPaymentListProps {
  payments: CounterPaymentRow[];
  canWrite: boolean;
}

export function CounterPaymentList({ payments, canWrite }: CounterPaymentListProps) {
  const router = useRouter();
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const cancel = () => {
    setVoidingId(null);
    setReason("");
    setError(null);
  };

  const confirmVoid = (event: React.FormEvent) => {
    event.preventDefault();
    if (!voidingId) return;
    if (reason.trim() === "") {
      setError("Informe o motivo da anulação.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await voidCounterPaymentAction({ id: voidingId, reason });
      if (res.error) {
        setError(res.error);
        return;
      }
      cancel();
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Pagamentos registrados</CardTitle>
      </CardHeader>
      <CardContent>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum pagamento de balcão neste Dossiê.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Forma</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Observação</TableHead>
                <TableHead>Situação</TableHead>
                {canWrite && <TableHead className="text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{dateFormat.format(new Date(p.receivedAt))}</TableCell>
                  <TableCell>{METHOD_LABEL[p.method]}</TableCell>
                  <TableCell className={p.voidedAt ? "line-through" : undefined}>
                    {formatCurrency(Number(p.amount))}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.note ?? "—"}</TableCell>
                  <TableCell>
                    {p.voidedAt ? (
                      <span className="space-y-1">
                        <Badge variant="secondary">Anulado</Badge>
                        {p.voidReason && <span className="block text-xs text-muted-foreground">{p.voidReason}</span>}
                      </span>
                    ) : (
                      <Badge variant="outline">Válido</Badge>
                    )}
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      {!p.voidedAt && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            cancel();
                            setVoidingId(p.id);
                          }}
                          disabled={isPending}
                        >
                          Anular
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {canWrite && voidingId && (
          <form onSubmit={confirmVoid} noValidate className="mt-4 space-y-2 rounded-md border p-4">
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
              <p id="cp-void-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={isPending || reason.trim() === ""}>
                {isPending ? "Anulando..." : "Confirmar anulação"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={isPending}>
                Cancelar
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
