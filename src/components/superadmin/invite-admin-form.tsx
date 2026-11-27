"use client";

import { useState, useTransition } from "react";

import { inviteBureauAdmin } from "@/actions/bureaus";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusBanner } from "@/components/ui/status-banner";
import { passwordFieldError, type PasswordErrorField } from "./password-error";

export function InviteAdminForm({ bureauId }: { bureauId: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<{ field: PasswordErrorField; message: string } | null>(null);
  const [sent, setSent] = useState<"email" | "password" | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPasswordError(null);
    setSent(null);
    if (password || confirm) {
      const invalid = passwordFieldError(password, confirm);
      if (invalid) {
        setPasswordError(invalid);
        document.getElementById(invalid.field === "confirm" ? "invite-confirm" : "invite-password")?.focus();
        return;
      }
    }
    const pw = password || undefined;
    setPassword("");
    setConfirm("");
    startTransition(async () => {
      const result = await inviteBureauAdmin({ bureauId, name, email, password: pw });
      if (result.error) setError(result.error);
      else setSent(pw ? "password" : "email");
    });
  };

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-4">
      <h3 className="text-base font-bold">Convidar ou reenviar convite ao administrador</h3>
      <Field id="invite-name" label="Nome completo">
        {(a11y) => <Input {...a11y} required value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field id="invite-email" label="E-mail">
        {(a11y) => <Input {...a11y} required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Field
        id="invite-password"
        label="Senha do administrador (opcional)"
        helper="Deixe em branco para enviar o convite por e-mail. Com senha, o administrador troca a senha no primeiro acesso."
        error={passwordError?.field === "password" ? passwordError.message : null}
      >
        {(a11y) => <PasswordInput {...a11y} value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      <Field
        id="invite-confirm"
        label="Confirmar senha"
        error={passwordError?.field === "confirm" ? passwordError.message : null}
      >
        {(a11y) => <PasswordInput {...a11y} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      {error && <StatusBanner tone="danger" title={error} />}
      {sent && (
        <StatusBanner
          tone="success"
          title={
            sent === "password"
              ? "Administrador criado. Informe a senha por um canal seguro. Ele troca a senha no primeiro acesso."
              : "Convite enviado."
          }
        />
      )}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Enviando..." : "Enviar convite"}
      </Button>
    </form>
  );
}
