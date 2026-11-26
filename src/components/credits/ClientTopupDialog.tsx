"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { requestClientTopupAction } from "@/actions/credits-topup";
import { CheckoutForm } from "@/components/payments/CheckoutForm";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ReferencePriceRow } from "@/lib/catalog/reference-prices";
import { CREDITS_PATH } from "@/lib/wallet/credits-path";

export function ClientTopupDialog({ priceRows }: { priceRows: ReferencePriceRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <Button variant="onBrand" size="lg" onClick={() => setOpen(true)}>
        Recarregar
      </Button>
      <Dialog open={open} onClose={close} title="Recarregar créditos" className="max-h-[92vh] max-w-lg overflow-y-auto">
        <CheckoutForm
          scope="client"
          action={requestClientTopupAction}
          priceRows={priceRows}
          onClose={close}
          // O QR abre na página, pela URL: sobrevive a re-render e remontagem deste diálogo.
          onPix={(charge) => {
            close();
            router.push(`${CREDITS_PATH}?pix=${charge.id}`);
          }}
        />
      </Dialog>
    </>
  );
}
