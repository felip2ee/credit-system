"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { acceptLegalDocumentsAction } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";

export interface AcceptLegalFormProps {
  termsVersion: number;
  privacyVersion: number;
}

export function AcceptLegalForm({ termsVersion, privacyVersion }: AcceptLegalFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const accept = () =>
    startTransition(async () => {
      setServerError(null);
      const result = await acceptLegalDocumentsAction({ termsVersion, privacyVersion });
      if (result.error) {
        setServerError(result.error);
        // Versão desatualizada: recarrega para buscar os textos vigentes.
        router.refresh();
        return;
      }
      router.replace("/portal");
      router.refresh();
    });

  return (
    <div className="space-y-3 rounded-card border border-border bg-background p-5">
      {serverError && <StatusBanner tone="attention" title={serverError} />}
      <Button type="button" size="lg" glow className="w-full" onClick={accept} disabled={isPending}>
        {isPending ? "Aceitando..." : "Aceitar e continuar"}
      </Button>
    </div>
  );
}
