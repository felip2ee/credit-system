"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setProductBlockAction } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProductBlockRow } from "@/lib/commission/queries";

function BlockRow({ bureauId, row, canWrite }: { bureauId: string; row: ProductBlockRow; canWrite: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setError(null);
    startTransition(async () => {
      const res = await setProductBlockAction({ bureauId, productId: row.productId, blocked: !row.blocked });
      if (res.error) return setError(res.error);
      router.refresh();
    });
  };

  return (
    <li className="space-y-2 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.name}</span>
        <span className="text-sm text-muted-foreground">{row.code}</span>
        {!row.productActive && <Badge variant="muted">Produto inativo</Badge>}
        <Badge variant={row.blocked ? "destructive" : "success"} className="ml-auto">
          {row.blocked ? "Bloqueado" : "Liberado"}
        </Badge>
        {canWrite && (
          <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={toggle}>
            {isPending ? "Salvando..." : row.blocked ? "Liberar" : "Bloquear"}
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {row.history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Histórico</summary>
          <ul className="mt-1 space-y-1">
            {row.history.map((h) => (
              <li key={h.id}>
                {h.blocked ? "Bloqueado" : "Liberado"} em {h.createdAt.toLocaleString("pt-BR")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function BureauProductBlocksPanel({
  bureauId,
  rows,
  canWrite,
}: {
  bureauId: string;
  rows: ProductBlockRow[];
  canWrite: boolean;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nenhum produto cadastrado.</p>;
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-muted-foreground">
        Produto bloqueado não é vendido por este Bureau. Pedidos já reservados seguem até a captura.
      </p>
      <ul className="space-y-3">
        {rows.map((row) => (
          <BlockRow key={row.productId} bureauId={bureauId} row={row} canWrite={canWrite} />
        ))}
      </ul>
    </div>
  );
}
