"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { confirmEmailAction } from "@/actions/register";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";

export interface ConfirmEmailButtonProps {
  token: string;
}

type Outcome = { error: string | null } | null;

export function ConfirmEmailButton({ token }: ConfirmEmailButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<Outcome>(null);

  const confirm = () =>
    startTransition(async () => {
      setOutcome(await confirmEmailAction(token));
    });

  if (outcome && !outcome.error) {
    return (
      <div className="space-y-3">
        <StatusBanner tone="success" title="E-mail confirmado." />
        <Button asChild size="lg" className="w-full">
          <Link href="/portal">Ir para o portal</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {outcome?.error && <StatusBanner tone="attention" title={outcome.error} />}
      {outcome?.error ? (
        <Button asChild size="lg" className="w-full">
          <Link href="/login">Entrar</Link>
        </Button>
      ) : (
        <Button type="button" size="lg" glow className="w-full" onClick={confirm} disabled={isPending}>
          {isPending ? "Confirmando..." : "Confirmar e-mail"}
        </Button>
      )}
    </div>
  );
}
