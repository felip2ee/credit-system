"use client";

import { useState, useTransition } from "react";

import { setBureauAdminCredentials } from "@/actions/bureaus";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";
import { passwordFieldError, type PasswordErrorField } from "./password-error";

export function AdminCredentialsForm({ bureauId }: { bureauId: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<{ field: PasswordErrorField; message: string } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = (withPassword: boolean) => {
    setError(null);
    setPasswordError(null);
    setSuccess(null);
    if (withPassword) {
      const invalid = passwordFieldError(password, confirm);
      if (invalid) {
        setPasswordError(invalid);
        document.getElementById(invalid.field === "confirm" ? "cred-confirm" : "cred-password")?.focus();
        return;
      }
    }
    const pw = withPassword ? password : undefined;
    setPassword("");
    setConfirm("");
    startTransition(async () => {
      const result = await setBureauAdminCredentials({ bureauId, email, password: pw });
      if (result.error) {
        setError(result.error);
        return;
      }
      setSuccess(
        pw
          ? "Senha definida. As sessões do administrador foram encerradas. Informe a senha por um canal seguro."
          : "Troca de senha exigida no próximo acesso. As sessões do administrador foram encerradas.",
      );
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(true);
      }}
      className="max-w-xl space-y-4"
    >
      <h3 className="text-base font-bold">Senha de um administrador</h3>
      <StatusBanner
        tone="attention"
        title="As sessões do administrador são encerradas"
        description="Tanto ao definir uma senha quanto ao forçar a troca, o administrador sai de todos os aparelhos e precisa entrar de novo. Os links pendentes de redefinição de senha dele também deixam de valer."
      />
      <Field id="cred-email" label="E-mail do administrador">
        {(a11y) => <Input {...a11y} required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Field
        id="cred-password"
        label="Nova senha temporária"
        helper="Usada só em Definir senha. O administrador troca a senha no próximo acesso."
        error={passwordError?.field === "password" ? passwordError.message : null}
      >
        {(a11y) => <PasswordInput {...a11y} value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      <Field
        id="cred-confirm"
        label="Confirmar senha"
        error={passwordError?.field === "confirm" ? passwordError.message : null}
      >
        {(a11y) => <PasswordInput {...a11y} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      {error && <StatusBanner tone="danger" title={error} />}
      {success && <StatusBanner tone="success" title={success} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Salvando..." : "Definir senha"}
        </Button>
        <Button type="button" variant="outline" disabled={isPending} onClick={() => submit(false)}>
          Forçar troca no próximo acesso
        </Button>
      </div>
    </form>
  );
}
