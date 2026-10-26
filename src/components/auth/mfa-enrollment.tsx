"use client";

import { useState } from "react";
import QRCode from "qrcode";

import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/auth/password-input";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";

export function MfaEnrollment({ onComplete }: { onComplete?: () => void }) {
  const [password, setPassword] = useState("");
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    // better-auth keeps user.twoFactorEnabled=false until the first verifyTotp
    // below succeeds, so a failed enrollment can't lock the account out.
    const result = await authClient.twoFactor.enable({ password });
    const data = result.data;
    if (result.error || !data || !("totpURI" in data)) {
      setError("Não foi possível iniciar o cadastro.");
    } else {
      setQrCode(await QRCode.toDataURL(data.totpURI));
      setBackupCodes(data.backupCodes ?? []);
      setPassword("");
    }
    setBusy(false);
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    const result = await authClient.twoFactor.verifyTotp({ code: code.trim(), trustDevice: false });
    setBusy(false);
    if (result.error || !result.data) {
      setError("Código inválido. Tente novamente.");
      return;
    }
    onComplete?.();
  };

  if (qrCode) {
    return (
      <div className="space-y-4 rounded-card border border-border bg-card p-4">
        <p className="text-base">Escaneie o QR code no seu app autenticador.</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrCode} alt="QR code TOTP" className="h-44 w-44" />
        <StatusBanner
          tone="attention"
          title="Guarde estes códigos de recuperação agora."
          description={
            <>
              <p>Eles não serão exibidos novamente.</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">
                {backupCodes.map((backupCode) => <li key={backupCode}>{backupCode}</li>)}
              </ul>
            </>
          }
        />
        <Field id="totp" label="Código de 6 dígitos">
          {(a) => <Input inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} {...a} />}
        </Field>
        {error && <StatusBanner tone="attention" title={error} />}
        <Button size="lg" glow className="w-full" onClick={verify} disabled={busy || code.length !== 6}>
          {busy ? "Verificando..." : "Confirmar autenticador"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Field id="current-password" label="Confirme sua senha">
        {(a) => (
          <PasswordInput
            withIcon
            toggleLabels={["Mostrar texto digitado", "Ocultar texto digitado"]}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...a}
          />
        )}
      </Field>
      {error && <StatusBanner tone="attention" title={error} />}
      <Button size="lg" glow className="w-full" onClick={start} disabled={busy || password.length < 12}>
        {busy ? "Gerando..." : "Adicionar autenticador"}
      </Button>
    </div>
  );
}
