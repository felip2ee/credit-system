"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  resendTeamInvite,
  setTeamMemberCredentials,
  setUserActive,
  setUserRole,
} from "@/actions/users";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { firstPasswordError } from "@/lib/validators/password";

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
  const [message, setMessage] = useState<string | null>(null);
  const [settingPassword, setSettingPassword] = useState(false);
  const [confirmingForce, setConfirmingForce] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const router = useRouter();
  const canManageCredentials = role === "operator" && !disabled;

  const runCredentials = (pw: string | undefined, okMessage: string) => {
    setError(null);
    setMessage(null);
    setPassword("");
    setConfirm("");
    startTransition(async () => {
      const result = await setTeamMemberCredentials({ userId, password: pw });
      if (result.error) setError(result.error);
      else {
        setMessage(okMessage);
        setSettingPassword(false);
        setConfirmingForce(false);
      }
      router.refresh();
    });
  };

  const savePassword = (e: React.FormEvent) => {
    e.preventDefault();
    const passwordError = firstPasswordError(password, confirm);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    runCredentials(password, "Senha definida. As sessões do usuário foram encerradas.");
  };

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
        {role === "operator" && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || isPending}
            onClick={() => run(() => setUserRole({ userId, role: "bureau_admin" }))}
          >
            Tornar administrador
          </Button>
        )}
        {canManageCredentials && (
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => {
              setSettingPassword((v) => !v);
              setConfirmingForce(false);
              setPassword("");
              setConfirm("");
            }}
          >
            Definir senha
          </Button>
        )}
        {canManageCredentials && !pendingInvite && (
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => {
              if (!confirmingForce) {
                setConfirmingForce(true);
                setSettingPassword(false);
                return;
              }
              runCredentials(undefined, "Troca de senha exigida no próximo acesso.");
            }}
          >
            {confirmingForce ? "Confirmar troca" : "Forçar troca"}
          </Button>
        )}
        <Button
          variant={isActive ? "outline" : "secondary"}
          size="sm"
          disabled={disabled || isPending}
          onClick={() => run(() => setUserActive({ userId, isActive: !isActive }))}
        >
          {isPending ? "..." : isActive ? "Desativar" : "Ativar"}
        </Button>
      </div>
      {canManageCredentials && settingPassword && (
        <form onSubmit={savePassword} className="flex w-72 flex-col gap-2 text-left">
          <PasswordInput
            aria-label="Nova senha"
            placeholder="Nova senha"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <PasswordInput
            aria-label="Confirmar senha"
            placeholder="Confirmar senha"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={isPending}>
              Salvar
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setSettingPassword(false);
                setPassword("");
                setConfirm("");
              }}
            >
              Cancelar
            </Button>
          </div>
        </form>
      )}
      {message && <p className="text-xs text-emerald-600">{message}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
