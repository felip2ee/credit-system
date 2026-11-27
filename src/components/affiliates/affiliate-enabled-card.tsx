"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setAffiliateEnabledAction } from "@/actions/affiliate-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusBanner } from "@/components/ui/status-banner";

interface AffiliateEnabledCardProps {
  enabled: boolean;
}

// Interruptor da seção de afiliado: desligada (padrão), os clientes do Bureau não veem nem usam a Afiliação.
export function AffiliateEnabledCard({ enabled }: AffiliateEnabledCardProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const toggle = () => {
    setError(null);
    startTransition(async () => {
      const res = await setAffiliateEnabledAction({ enabled: !enabled });
      if (res.error) return setError(res.error);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-lg">Afiliação para os clientes</CardTitle>
          <StatusBadge tone={enabled ? "success" : "neutral"} label={enabled ? "Ligada" : "Desligada"} />
        </div>
        <CardDescription>
          {enabled
            ? "Seus clientes veem a Afiliação no portal, indicam novos clientes e recebem comissão."
            : "Seus clientes não veem a Afiliação no portal e ninguém recebe comissão de indicação por link."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <StatusBanner tone="danger" title={error} />}
        <Button type="button" variant={enabled ? "outline" : "default"} disabled={isPending} onClick={toggle}>
          {isPending ? "Salvando…" : enabled ? "Desligar afiliação" : "Ligar afiliação"}
        </Button>
      </CardContent>
    </Card>
  );
}
