"use client";

import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/page-header";
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

interface Factor {
  id: string;
  friendlyName: string | null;
  status: string;
}

interface EnrollState {
  factorId: string;
  qrCode: string;
  secret: string;
}

export default function SecurityPage() {
  const supabase = createClient();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [enroll, setEnroll] = useState<EnrollState | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors(
      (data?.totp ?? []).map((f) => ({
        id: f.id,
        friendlyName: f.friendly_name ?? null,
        status: f.status,
      }))
    );
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startEnroll = async () => {
    setError(null);
    setBusy(true);
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Autenticador ${new Date().toLocaleDateString("pt-BR")}`,
    });
    setBusy(false);
    if (error || !data) {
      setError(error?.message ?? "Falha ao iniciar o cadastro.");
      return;
    }
    setEnroll({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    });
  };

  const confirmEnroll = async () => {
    if (!enroll) return;
    setError(null);
    setBusy(true);
    const challenge = await supabase.auth.mfa.challenge({
      factorId: enroll.factorId,
    });
    if (challenge.error || !challenge.data) {
      setBusy(false);
      setError(challenge.error?.message ?? "Falha no desafio.");
      return;
    }
    const verify = await supabase.auth.mfa.verify({
      factorId: enroll.factorId,
      challengeId: challenge.data.id,
      code: code.trim(),
    });
    setBusy(false);
    if (verify.error) {
      setError("Código inválido. Tente novamente.");
      return;
    }
    setEnroll(null);
    setCode("");
    await refresh();
  };

  const cancelEnroll = async () => {
    if (enroll) {
      await supabase.auth.mfa.unenroll({ factorId: enroll.factorId });
    }
    setEnroll(null);
    setCode("");
    setError(null);
  };

  const removeFactor = async (factorId: string) => {
    setBusy(true);
    await supabase.auth.mfa.unenroll({ factorId });
    setBusy(false);
    await refresh();
  };

  const verifiedFactors = factors.filter((f) => f.status === "verified");

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title="Segurança (MFA)"
        description="Autenticação em dois fatores via aplicativo TOTP"
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Autenticadores</CardTitle>
          <CardDescription>
            Use um app como Google Authenticator, Authy ou 1Password.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : verifiedFactors.length > 0 ? (
            <ul className="space-y-2">
              {verifiedFactors.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between rounded-md border p-3 text-sm"
                >
                  <span>{f.friendlyName ?? "Autenticador TOTP"}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeFactor(f.id)}
                    disabled={busy}
                  >
                    Remover
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nenhum autenticador cadastrado.
            </p>
          )}

          {!enroll && (
            <Button onClick={startEnroll} disabled={busy}>
              Adicionar autenticador
            </Button>
          )}

          {enroll && (
            <div className="space-y-4 rounded-md border p-4">
              <p className="text-sm">
                Escaneie o QR code no seu app autenticador:
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enroll.qrCode}
                alt="QR code TOTP"
                className="h-44 w-44"
              />
              <p className="text-xs text-muted-foreground">
                Ou insira o código manualmente:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  {enroll.secret}
                </code>
              </p>
              <div className="space-y-2">
                <Label htmlFor="totp">Código de 6 dígitos</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={confirmEnroll} disabled={busy || code.length < 6}>
                  Confirmar
                </Button>
                <Button variant="ghost" onClick={cancelEnroll} disabled={busy}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
