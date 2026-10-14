"use client";

import { useState, useTransition } from "react";

import { inviteBureauAdmin } from "@/actions/bureaus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function InviteAdminForm({ bureauId }: { bureauId: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSent(false);
    startTransition(async () => {
      const result = await inviteBureauAdmin({ bureauId, name, email });
      if (result.error) setError(result.error);
      else setSent(true);
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
      {error && <p className="text-sm text-destructive">{error}</p>}
      {sent && <p className="text-sm text-emerald-600">Convite enviado.</p>}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Enviando..." : "Enviar convite"}
      </Button>
    </form>
  );
}
