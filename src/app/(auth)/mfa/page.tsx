"use client";

import { useEffect, useState } from "react";

import { signOut } from "@/actions/auth";
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
import { createClient } from "@/lib/supabase/client";

export default function MfaVerifyPage() {
  const supabase = createClient();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data }) => {
      const verified = (data?.totp ?? []).find((f) => f.status === "verified");
      setFactorId(verified?.id ?? null);
      setLoading(false);
    });
  }, [supabase]);

  const verify = async () => {
    if (!factorId) return;
    setError(null);
    setBusy(true);
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data) {
      setBusy(false);
      setError(challenge.error?.message ?? "Falha no desafio.");
      return;
    }
    const result = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code: code.trim(),
    });
    if (result.error) {
      setBusy(false);
      setError("Código inválido. Tente novamente.");
      return;
    }
    // Recarrega para o middleware reavaliar a sessão já em aal2.
    window.location.href = "/";
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl">Verificação em dois fatores</CardTitle>
        <CardDescription>
          Digite o código do seu app autenticador
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Carregando...</p>
        ) : factorId ? (
          <>
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
          </>
        ) : (
          <p className="text-sm text-destructive">
            Nenhum autenticador encontrado para esta conta.
          </p>
        )}

        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm" className="w-full">
            Sair
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
