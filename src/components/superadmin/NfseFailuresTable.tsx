"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { retryNfseAction } from "@/actions/nfse";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDateTime } from "@/lib/utils";

export interface NfseFailureView {
  chargeId: string;
  bureauName: string;
  amount: string;
  attempts: number;
  updatedAt: Date | null;
  createdAt: Date;
}

function RetryButton({ chargeId, label }: { chargeId: string; label: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const retry = () => {
    setError(null);
    startTransition(async () => {
      const res = await retryNfseAction({ chargeId });
      if (res.error) setError(res.error);
      router.refresh();
    });
  };

  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" onClick={retry} disabled={isPending} aria-label={`Tentar de novo a nota da cobrança ${label}`}>
        {isPending ? "Enviando..." : "Tentar de novo"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function NfseFailuresTable({ rows, canRetry }: { rows: NfseFailureView[]; canRetry: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nenhuma nota fiscal com falha.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Cobrança</TableHead>
          <TableHead>Bureau</TableHead>
          <TableHead>Valor</TableHead>
          <TableHead>Tentativas</TableHead>
          <TableHead>Última atualização</TableHead>
          {canRetry && <TableHead>Ação</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.chargeId}>
            <TableCell className="font-mono text-xs">{row.chargeId.slice(0, 8)}</TableCell>
            <TableCell>{row.bureauName}</TableCell>
            <TableCell>{formatCurrency(Number(row.amount))}</TableCell>
            <TableCell>{row.attempts}</TableCell>
            <TableCell>{formatDateTime(row.updatedAt ?? row.createdAt)}</TableCell>
            {canRetry && (
              <TableCell>
                <RetryButton chargeId={row.chargeId} label={`${row.chargeId.slice(0, 8)} (${row.bureauName})`} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
