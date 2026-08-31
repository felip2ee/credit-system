"use client";

import { useState } from "react";

import { signOut } from "@/actions/auth";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl">Verificação em dois fatores</CardTitle>
        <CardDescription>Digite o código do seu app autenticador</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="totp">Código de 6 dígitos</Label>
          <Input
            id="totp"
            inputMode="numeric"
            maxLength={6}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="000000"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          className="w-full"
          onClick={verify}
          disabled={busy || code.length < 6}
        >
          {busy ? "Verificando..." : "Verificar"}
        </Button>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm" className="w-full">
            Sair
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
