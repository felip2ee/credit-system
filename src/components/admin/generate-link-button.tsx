"use client";

import { useState, useTransition } from "react";
import { Link2 } from "lucide-react";

import { createPaymentLinkAction } from "@/actions/payment-links";
import { Button } from "@/components/ui/button";

import { ShareLinkPanel } from "./share-link-panel";

interface GenerateLinkButtonProps {
  orderId: string;
  bureauName: string;
  productName: string;
  label?: string;
}

// Cada clique emite um link novo e cancela o anterior (o token em claro só existe na criação).
export function GenerateLinkButton({ orderId, bureauName, productName, label = "Gerar link de pagamento" }: GenerateLinkButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = () => {
    setError(null);
    startTransition(async () => {
      const res = await createPaymentLinkAction({ orderId });
      if (res.error || !res.url) {
        setError(res.error ?? "Não foi possível gerar o link.");
        return;
      }
      setUrl(res.url);
    });
  };

  return (
    <div className="space-y-3">
      <Button type="button" onClick={generate} disabled={isPending} variant={url ? "outline" : "default"} size={url ? "sm" : "default"}>
        <Link2 aria-hidden className="h-4 w-4" />
        {isPending ? "Gerando..." : url ? "Gerar outro link" : label}
      </Button>
      <div aria-live="polite">{error && <p className="text-sm text-destructive">{error}</p>}</div>
      {url && <ShareLinkPanel url={url} bureauName={bureauName} productName={productName} />}
    </div>
  );
}
