"use client";

import { MessageCircle } from "lucide-react";

import { CopyLinkButton } from "@/components/superadmin/copy-link-button";
import { Button } from "@/components/ui/button";

import { buildWhatsappUrl } from "./share-link";

// Link gerado: copiar e enviar por WhatsApp (sem número: o operador escolhe o contato no app).
export function ShareLinkPanel({ url, bureauName, productName }: { url: string; bureauName: string; productName: string }) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
      <p className="break-all text-sm font-medium">{url}</p>
      <div className="flex flex-wrap gap-2">
        <CopyLinkButton url={url} label="Copiar link de pagamento" />
        <Button asChild size="sm">
          <a href={buildWhatsappUrl({ bureauName, productName, url })} target="_blank" rel="noreferrer">
            <MessageCircle aria-hidden className="h-4 w-4" />
            Enviar por WhatsApp
          </a>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Vale por 7 dias. Gerar outro link cancela este.</p>
    </div>
  );
}
