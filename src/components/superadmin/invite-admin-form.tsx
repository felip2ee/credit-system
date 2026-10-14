"use client";

import { useState, useTransition } from "react";

import { inviteBureauAdmin } from "@/actions/bureaus";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { newPasswordSchema } from "@/lib/validators/password";

export function InviteAdminForm({ bureauId }: { bureauId: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<"email" | "password" | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSent(null);
    if (password || confirm) {
      const check = newPasswordSchema.safeParse({ password, confirm });
      if (!check.success) {
        setError(check.error.issues[0]?.message ?? "Senha inválida.");
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
    <form onSubmit={onSubmit} className="max-w-xl space-y-4 border-t pt-6">
      <h2 className="text-lg font-semibold">Convidar ou reenviar convite ao admin</h2>
      <div className="space-y-2">
        <Label htmlFor="invite-name">Nome completo</Label>
        <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-email">E-mail</Label>
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-password">Senha do administrador</Label>
        <PasswordInput
          id="invite-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Deixe em branco para enviar o convite por e-mail. Com senha, o administrador
          troca a senha no primeiro acesso.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-confirm">Confirmar senha</Label>
        <PasswordInput
          id="invite-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {sent && (
        <p className="text-sm text-emerald-600">
          {sent === "password"
            ? "Administrador criado. Informe a senha por um canal seguro. Ele troca a senha no primeiro acesso."
            : "Convite enviado."}
        </p>
      )}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Enviando..." : "Enviar convite"}
      </Button>
    </form>
  );
}
