"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";

import {
  inviteClientToPortal,
  revokeClientPortalAccess,
} from "@/actions/portal";
import { Button } from "@/components/ui/button";

interface PortalAccessButtonProps {
  clientId: string;
  hasAccess: boolean;
  hasEmail: boolean;
}

export function PortalAccessButton({
  clientId,
  hasAccess,
  hasEmail,
}: PortalAccessButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const invite = () => {
    setError(null);
    setOk(null);
    startTransition(async () => {
      const res = await inviteClientToPortal(clientId);
      if (res.error) {
        setError(res.error);
        return;
      }
      setOk("Convite enviado por e-mail.");
      router.refresh();
    });
  };

  const revoke = () => {
    if (!window.confirm("Revogar o acesso deste cliente ao portal?")) return;
    setError(null);
    setOk(null);
    startTransition(async () => {
      const res = await revokeClientPortalAccess(clientId);
      if (res.error) {
        setError(res.error);
        return;
      }
      setOk("Acesso revogado.");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      {hasAccess ? (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-emerald-600">
            <ShieldCheck className="h-3.5 w-3.5" />
            Portal ativo
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={revoke}
            disabled={isPending}
          >
            <ShieldOff className="h-4 w-4" />
            {isPending ? "Revogando..." : "Revogar acesso"}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={invite}
          disabled={isPending || !hasEmail}
          title={hasEmail ? undefined : "Cadastre um e-mail no cliente primeiro"}
        >
          <KeyRound className="h-4 w-4" />
          {isPending ? "Enviando..." : "Dar acesso ao portal"}
        </Button>
      )}
      {!hasEmail && !hasAccess && (
        <p className="text-xs text-muted-foreground">
          Cadastre um e-mail para liberar o acesso.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {ok && <p className="text-xs text-emerald-600">{ok}</p>}
    </div>
  );
}
