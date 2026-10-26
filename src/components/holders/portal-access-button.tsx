"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldOff } from "lucide-react";

import {
  inviteHolderToPortal,
  revokeHolderPortalAccess,
} from "@/actions/portal";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";
import { StatusBadge } from "@/components/ui/status-badge";

interface PortalAccessButtonProps {
  holderId: string;
  hasAccess: boolean;
  hasEmail: boolean;
}

export function PortalAccessButton({
  holderId,
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
      const res = await inviteHolderToPortal(holderId);
      if (res.error) {
        setError(res.error);
        return;
      }
      setOk("Convite enviado por e-mail.");
      router.refresh();
    });
  };

  const revoke = () => {
    if (!window.confirm("Revogar o acesso deste titular ao portal?")) return;
    setError(null);
    setOk(null);
    startTransition(async () => {
      const res = await revokeHolderPortalAccess(holderId);
      if (res.error) {
        setError(res.error);
        return;
      }
      setOk("Acesso revogado.");
      router.refresh();
    });
  };

  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-2 sm:w-auto sm:max-w-xs sm:items-end">
      {hasAccess ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="success" label="Portal ativo" />
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
          title={hasEmail ? undefined : "Cadastre um e-mail no titular primeiro"}
        >
          <KeyRound className="h-4 w-4" />
          {isPending ? "Enviando..." : "Dar acesso ao portal"}
        </Button>
      )}
      {!hasEmail && !hasAccess && (
        <p className="text-sm text-muted-foreground sm:text-right">
          Cadastre um e-mail para liberar o acesso.
        </p>
      )}
      {error && <p className="text-sm text-destructive sm:text-right">{error}</p>}
      {ok && <StatusBanner tone="success" title={ok} />}
    </div>
  );
}
