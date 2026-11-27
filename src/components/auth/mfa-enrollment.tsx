"use client";

import { useEffect, useRef, useState } from "react";
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
  const [copyStatus, setCopyStatus] = useState("");
  const stepTitleRef = useRef<HTMLHeadingElement>(null);

  // Só move o foco ao avançar para a etapa 2; na primeira exibição o foco fica onde está.
  useEffect(() => {
    if (qrCode) stepTitleRef.current?.focus();
  }, [qrCode]);

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

  // Copia só quando a pessoa clica. Os códigos não vão para log nem para armazenamento.
  const copyBackupCodes = async () => {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      setCopyStatus("Códigos copiados.");
    } catch {
      setCopyStatus("Não foi possível copiar. Anote os códigos à mão.");
    }
  };

  if (qrCode) {
    return (
      <div className="space-y-4 rounded-card border border-border bg-card p-4">
        <div className="space-y-1">
          <h2 ref={stepTitleRef} tabIndex={-1} className="text-base font-bold focus-visible:outline-none">
            Passo 2 de 2: confirme o autenticador
          </h2>
          <p className="text-base">Escaneie o QR code no seu app autenticador.</p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrCode} alt="QR code TOTP" className="h-44 w-44" />
        <StatusBanner
          tone="attention"
          title="Guarde estes códigos de recuperação agora."
          description={
            <>
              <p>Eles não serão exibidos novamente. Guarde-os antes de sair desta tela.</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">
                {backupCodes.map((backupCode) => <li key={backupCode}>{backupCode}</li>)}
              </ul>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={copyBackupCodes}>
                Copiar códigos
              </Button>
              <p role="status" className="mt-2 text-sm">{copyStatus}</p>
            </>
          }
        />
        <Field id="totp" label="Código de 6 dígitos">
          {(a) => <Input inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} {...a} />}
        </Field>
        {error && <StatusBanner tone="attention" title={error} />}
        <Button glow className="w-full" onClick={verify} disabled={busy || code.length !== 6}>
          {busy ? "Verificando..." : "Confirmar autenticador"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 ref={stepTitleRef} tabIndex={-1} className="text-base font-bold focus-visible:outline-none">
          Passo 1 de 2: confirme sua identidade
        </h2>
        <p className="text-sm text-muted-foreground">
          Depois você escaneia um QR code e recebe códigos de recuperação.
        </p>
      </div>
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
      <Button glow className="w-full" onClick={start} disabled={busy || password.length < 12}>
        {busy ? "Gerando..." : "Adicionar autenticador"}
      </Button>
    </div>
  );
}
