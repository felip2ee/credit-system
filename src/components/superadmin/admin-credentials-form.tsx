"use client";

import { useState, useTransition } from "react";

import { setBureauAdminCredentials } from "@/actions/bureaus";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { firstPasswordError } from "@/lib/validators/password";

export function AdminCredentialsForm({ bureauId }: { bureauId: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = (withPassword: boolean) => {
    setError(null);
    setSuccess(null);
    if (withPassword) {
      const passwordError = firstPasswordError(password, confirm);
      if (passwordError) {
        setError(passwordError);
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
          : "Troca de senha exigida no próximo acesso.",
      );
    });
  };

  return (
    <form
      onSubmit={(e) => e.preventDefault()}
      className="max-w-xl space-y-4 border-t pt-6"
    >
      <h2 className="text-lg font-semibold">Senha de um administrador</h2>
      <div className="space-y-2">
        <Label htmlFor="cred-email">E-mail do administrador</Label>
        <Input
          id="cred-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cred-password">Nova senha temporária</Label>
        <PasswordInput
          id="cred-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cred-confirm">Confirmar senha</Label>
        <PasswordInput
          id="cred-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-emerald-600">{success}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={isPending} onClick={() => submit(true)}>
          {isPending ? "Salvando..." : "Definir senha"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => submit(false)}
        >
          Forçar troca no próximo acesso
        </Button>
      </div>
    </form>
  );
}
