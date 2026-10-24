"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setAffiliatePctAction, setDefaultPctAction } from "@/actions/affiliates-bureau";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BureauAffiliate } from "@/lib/affiliates/rates";
import { formatCurrency } from "@/lib/utils";
import { StatusBanner } from "@/components/ui/status-banner";

interface BureauAffiliatesTableProps {
  defaultPct: string;
  affiliates: BureauAffiliate[];
}

function DefaultPctForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [pct, setPct] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await setDefaultPctAction({ pct });
      if (res.error) return setError(res.error);
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" noValidate>
      <div className="space-y-2">
        <Label htmlFor="default-pct">% padrão de comissão</Label>
        <Input
          id="default-pct"
          inputMode="decimal"
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          disabled={isPending}
          className="w-32"
        />
      </div>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Salvando..." : "Salvar"}
      </Button>
      {error && (
        <StatusBanner tone="danger" title={error} />
      )}
      {saved && !error && <StatusBanner tone="success" title="Porcentagem padrão salva." />}
    </form>
  );
}

function AffiliateRow({ affiliate }: { affiliate: BureauAffiliate }) {
  const router = useRouter();
  const [pct, setPct] = useState(affiliate.pct ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Campo vazio remove a % própria: o afiliado volta ao padrão.
  const save = () => {
    setError(null);
    startTransition(async () => {
      const res = await setAffiliatePctAction({
        affiliateProfileId: affiliate.profileId,
        pct: pct.trim() === "" ? null : pct,
      });
      if (res.error) return setError(res.error);
      router.refresh();
    });
  };

  return (
    <TableRow>
      <TableCell className="font-medium">{affiliate.name}</TableCell>
      <TableCell className="font-mono text-sm">{affiliate.code}</TableCell>
      <TableCell>{affiliate.referrals}</TableCell>
      <TableCell>{affiliate.pct === null ? "padrão" : `${affiliate.pct}%`}</TableCell>
      <TableCell>{formatCurrency(Number(affiliate.totalCommission))}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            inputMode="decimal"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            placeholder="padrão"
            aria-label={`% própria de ${affiliate.name}`}
            disabled={isPending}
            className="h-8 w-24"
          />
          <Button type="button" size="sm" variant="outline" onClick={save} disabled={isPending}>
            {isPending ? "Salvando..." : "Salvar"}
          </Button>
        </div>
        {error && (
          <StatusBanner tone="danger" title={error} />
        )}
      </TableCell>
    </TableRow>
  );
}

export function BureauAffiliatesTable({ defaultPct, affiliates }: BureauAffiliatesTableProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Comissão padrão</CardTitle>
          <CardDescription>
            Vale para todo afiliado sem % própria. Deixe a % própria vazia para voltar ao padrão.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DefaultPctForm initial={defaultPct} />
        </CardContent>
      </Card>
      {affiliates.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum afiliado ainda.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Código</TableHead>
              <TableHead>Indicados</TableHead>
              <TableHead>% aplicada</TableHead>
              <TableHead>Total de comissão</TableHead>
              <TableHead>Editar % própria</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {affiliates.map((a) => (
              <AffiliateRow key={a.profileId} affiliate={a} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
