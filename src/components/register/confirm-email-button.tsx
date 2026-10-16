"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { confirmEmailAction } from "@/actions/register";
import { Button } from "@/components/ui/button";

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
        <p role="status" className="font-medium">E-mail confirmado.</p>
        <Link href="/portal" className="inline-block font-medium underline underline-offset-4">
          Ir para o portal
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {outcome?.error && (
        <p role="alert" className="text-sm text-destructive">
          {outcome.error}
        </p>
      )}
      {outcome?.error ? (
        <Link href="/login" className="inline-block font-medium underline underline-offset-4">
          Entrar
        </Link>
      ) : (
        <Button type="button" onClick={confirm} disabled={isPending}>
          {isPending ? "Confirmando..." : "Confirmar e-mail"}
        </Button>
      )}
    </div>
  );
}
