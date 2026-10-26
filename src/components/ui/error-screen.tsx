"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import { failureMessage } from "@/lib/ui/failure-message";

// Tela de erro das rotas. Nunca mostra a mensagem técnica; ela vai só para o console.
export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("route error", error.digest ?? "");
  }, [error]);

  const msg = failureMessage({
    what: "Algo deu errado e não conseguimos mostrar esta página.",
    money: "none",
    next: "Tente de novo. Se continuar, fale com o suporte.",
  });
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center gap-4 p-6">
      <StatusBanner
        tone="danger"
        title={msg.title}
        description={msg.next}
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={reset}>Tentar de novo</Button>
            <Button asChild variant="outline">
              <Link href="/">Voltar ao início</Link>
            </Button>
          </div>
        }
      />
    </main>
  );
}
