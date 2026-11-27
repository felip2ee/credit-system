"use client";

import { useState } from "react";

import { PayoutMethodCards } from "@/components/affiliates/PayoutMethodCards";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { PayoutSettings } from "@/lib/affiliates/payout-settings";

interface AffiliatePayoutDialogProps {
  profileId: string;
  name: string;
  current: PayoutSettings;
}

// Dono do bureau cadastra o walletId (ou troca o modo) em nome do afiliado.
export function AffiliatePayoutDialog({ profileId, name, current }: AffiliatePayoutDialogProps) {
  const [open, setOpen] = useState(false);
  const summary =
    current.method === "asaas" ? `Conta Asaas${current.walletIdMasked ? ` (${current.walletIdMasked})` : ""}` : "Chave Pix";
  return (
    <>
      <span className="mr-3 text-sm">{summary}</span>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Configurar<span className="sr-only"> pagamento de {name}</span>
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Pagamento de ${name}`}
        description={`Escolha como ${name} recebe a comissão e salve.`}
        className="max-w-4xl"
      >
        <PayoutMethodCards current={current} profileId={profileId} subject={name} />
      </Dialog>
    </>
  );
}
