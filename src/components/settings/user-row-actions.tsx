"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { resendTeamInvite, setUserActive, setUserRole } from "@/actions/users";
import { Button } from "@/components/ui/button";

interface UserRowActionsProps {
  userId: string;
  isActive: boolean;
  role: string;
  pendingInvite: boolean;
  disabled?: boolean;
}

export function UserRowActions({
  userId,
  isActive,
  role,
  pendingInvite,
  disabled,
}: UserRowActionsProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const run = (action: () => Promise<{ error: string | null }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex justify-end gap-2">
        {pendingInvite && (
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => run(() => resendTeamInvite({ userId }))}
          >
            Reenviar
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || isPending}
          onClick={() =>
            run(() =>
              setUserRole({
                userId,
                role: role === "bureau_admin" ? "operator" : "bureau_admin",
              }),
            )
          }
        >
          {role === "bureau_admin" ? "Tornar operador" : "Tornar administrador"}
        </Button>
        <Button
          variant={isActive ? "outline" : "secondary"}
          size="sm"
          disabled={disabled || isPending}
          onClick={() => run(() => setUserActive({ userId, isActive: !isActive }))}
        >
          {isPending ? "..." : isActive ? "Desativar" : "Ativar"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
