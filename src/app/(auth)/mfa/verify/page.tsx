"use client";

import { useState } from "react";

import { signOut } from "@/actions/auth";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { KeyRound } from "lucide-react";

import { AuthHeading } from "@/components/auth/auth-heading";
import { IconInput } from "@/components/auth/icon-input";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";

export default function MfaVerifyPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = async () => {
    setError(null);
    setBusy(true);
    const result = await authClient.twoFactor.verifyTotp({
      code: code.trim(),
      trustDevice: false,
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError("Código inválido. Tente novamente.");
      return;
    }
    window.location.href = "/";
  };

  return (
    <section className="w-full max-w-md space-y-8">
      <AuthHeading title="Verificação em dois fatores" description="Digite o código do seu app autenticador" />
      <div className="space-y-5">
        <Field id="totp" label="Código de 6 dígitos">
          {(a) => (
            <IconInput
              icon={KeyRound}
              inputMode="numeric"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              className="tracking-widest tabular-nums"
              {...a}
            />
          )}
        </Field>
        {error && <StatusBanner tone="attention" title={error} />}
        <Button size="lg" glow className="w-full" onClick={verify} disabled={busy || code.length < 6}>
          {busy ? "Verificando..." : "Verificar"}
        </Button>
        <form action={signOut}>
          <Button type="submit" variant="outline" size="lg" className="w-full">
            Sair
          </Button>
        </form>
      </div>
    </section>
  );
}
