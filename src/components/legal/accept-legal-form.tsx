"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { acceptLegalDocumentsAction } from "@/actions/account";
import { Button } from "@/components/ui/button";

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
    <div className="space-y-3 border-t pt-6">
      {serverError && (
        <p role="alert" className="text-sm text-destructive">
          {serverError}
        </p>
      )}
      <Button type="button" onClick={accept} disabled={isPending}>
        {isPending ? "Aceitando..." : "Aceitar e continuar"}
      </Button>
    </div>
  );
}
