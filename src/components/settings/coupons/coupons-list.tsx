"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ticket } from "lucide-react";

import { setCouponActiveAction } from "@/actions/coupons";
import { CouponForm } from "@/components/settings/coupons/coupon-form";
import {
  limitLabel,
  PRODUCT_LABELS,
  type CouponProductCode,
} from "@/components/settings/coupons/coupon-form-logic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CouponRow } from "@/lib/coupons/queries";
import { formatCurrency, formatDateSP } from "@/lib/utils";

function valueLabel(coupon: CouponRow): string {
  if (coupon.kind === "fixed") return formatCurrency(Number(coupon.value));
  return `${Number(coupon.value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
}

function productsLabel(coupon: CouponRow): string {
  if (coupon.allProducts) return "Todos";
  return coupon.productCodes
    .map((c) => PRODUCT_LABELS[c as CouponProductCode] ?? c)
    .join(", ");
}

function validityLabel(coupon: CouponRow): string {
  const from = formatDateSP(coupon.validFrom);
  return coupon.validUntil
    ? `${from} a ${formatDateSP(coupon.validUntil)}`
    : `Desde ${from}`;
}

function CouponActions({ coupon }: { coupon: CouponRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = () =>
    startTransition(async () => {
      setError(null);
      const res = await setCouponActiveAction({
        id: coupon.id,
        active: !coupon.active,
      });
      if (res.error) setError(res.error);
      else router.refresh();
    });

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          aria-label={`Editar cupom ${coupon.code}`}
          onClick={() => setEditing(true)}
        >
          Editar
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          aria-label={`${coupon.active ? "Desativar" : "Ativar"} cupom ${coupon.code}`}
          onClick={toggle}
          disabled={isPending}
        >
          {coupon.active ? "Desativar" : "Ativar"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-sm font-bold text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title={`Editar cupom ${coupon.code}`}
      >
        <CouponForm coupon={coupon} onDone={() => setEditing(false)} />
      </Dialog>
    </>
  );
}

function CouponRowView({ coupon }: { coupon: CouponRow }) {
  return (
    <TableRow>
      <TableCell className="font-mono font-bold">{coupon.code}</TableCell>
      <TableCell>
        {valueLabel(coupon)}
        <span className="block text-xs text-muted-foreground">
          {coupon.kind === "percent" ? "Percentual" : "Valor fixo"}
        </span>
      </TableCell>
      <TableCell>{productsLabel(coupon)}</TableCell>
      <TableCell className="tabular-nums">
        {coupon.uses} / {limitLabel(coupon.maxUses)}
        <span className="block text-xs text-muted-foreground">
          Por cliente: {limitLabel(coupon.maxUsesPerClient)}
        </span>
      </TableCell>
      <TableCell>{validityLabel(coupon)}</TableCell>
      <TableCell>
        <Badge variant={coupon.active ? "brand" : "muted"}>
          {coupon.active ? "Ativo" : "Inativo"}
        </Badge>
      </TableCell>
      <TableCell>
        <CouponActions coupon={coupon} />
      </TableCell>
    </TableRow>
  );
}

function CouponCardView({ coupon }: { coupon: CouponRow }) {
  return (
    <li className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono font-bold">{coupon.code}</p>
          <p className="text-sm text-muted-foreground">
            {valueLabel(coupon)} ·{" "}
            {coupon.kind === "percent" ? "Percentual" : "Valor fixo"}
          </p>
        </div>
        <Badge variant={coupon.active ? "brand" : "muted"}>
          {coupon.active ? "Ativo" : "Inativo"}
        </Badge>
      </div>
      <dl className="space-y-1 text-sm">
        <div>
          <dt className="inline text-muted-foreground">Produtos: </dt>
          <dd className="inline">{productsLabel(coupon)}</dd>
        </div>
        <div className="tabular-nums">
          <dt className="inline text-muted-foreground">Usos / limite: </dt>
          <dd className="inline">
            {coupon.uses} / {limitLabel(coupon.maxUses)} (por cliente:{" "}
            {limitLabel(coupon.maxUsesPerClient)})
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Validade: </dt>
          <dd className="inline">{validityLabel(coupon)}</dd>
        </div>
      </dl>
      <CouponActions coupon={coupon} />
    </li>
  );
}

export function CouponsList({ coupons }: { coupons: CouponRow[] }) {
  const [creating, setCreating] = useState(false);

  const createButton = (
    <Button className="min-h-11" onClick={() => setCreating(true)}>
      Novo cupom
    </Button>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>Cupons de desconto</CardTitle>
        {coupons.length > 0 && createButton}
      </CardHeader>
      <CardContent>
        {coupons.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title="Nenhum cupom ainda"
            description="Crie um cupom para dar desconto nos dossiês dos seus clientes."
            action={createButton}
          />
        ) : (
          <>
            <ul className="divide-y rounded-card border md:hidden">
              {coupons.map((coupon) => (
                <CouponCardView key={coupon.id} coupon={coupon} />
              ))}
            </ul>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Desconto</TableHead>
                    <TableHead>Produtos</TableHead>
                    <TableHead>Usos / limite</TableHead>
                    <TableHead>Validade</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>
                      <span className="sr-only">Ações</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {coupons.map((coupon) => (
                    <CouponRowView key={coupon.id} coupon={coupon} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        <Dialog
          open={creating}
          onClose={() => setCreating(false)}
          title="Novo cupom"
        >
          <CouponForm onDone={() => setCreating(false)} />
        </Dialog>
      </CardContent>
    </Card>
  );
}
