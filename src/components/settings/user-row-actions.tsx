"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import {
  resendTeamInvite,
  setTeamMemberCredentials,
  setUserActive,
  setUserRole,
} from "@/actions/users";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { StatusBanner } from "@/components/ui/status-banner";
import { firstPasswordError } from "@/lib/validators/password";

interface UserRowActionsProps {
  userId: string;
  isActive: boolean;
  role: string;
  pendingInvite: boolean;
  disabled?: boolean;
}

type Kind = "promote" | "deactivate" | "activate" | "forceChange" | "setPassword";

// A consequência de cada ação, como o código a executa (src/actions/users.ts e lib/auth/credentials.ts).
const COPY: Record<Kind, { title: string; consequence: string; confirm: string; done: string; destructive?: boolean }> = {
  promote: {
    title: "Tornar administrador?",
    consequence:
      "A pessoa passa a gerenciar a equipe, ver a auditoria e recarregar a carteira. Ela sai de todos os aparelhos e entra de novo. Não há como voltar para Operador por esta tela.",
    confirm: "Tornar administrador",
    done: "Perfil alterado para Administrador. As sessões da pessoa foram encerradas.",
  },
  deactivate: {
    title: "Desativar este usuário?",
    consequence:
      "A pessoa perde o acesso agora e sai de todos os aparelhos. Os dados dela ficam guardados. Você pode ativar de novo depois.",
    confirm: "Desativar",
    done: "Usuário desativado. As sessões dele foram encerradas.",
    destructive: true,
  },
  activate: {
    title: "Ativar este usuário?",
    consequence: "A pessoa volta a poder entrar com a mesma conta e o mesmo perfil.",
    confirm: "Ativar",
    done: "Usuário ativado.",
  },
  forceChange: {
    title: "Exigir troca de senha?",
    consequence:
      "No próximo acesso a pessoa precisa criar uma nova senha. As sessões abertas dela são encerradas.",
    confirm: "Exigir troca",
    done: "Troca de senha exigida no próximo acesso.",
  },
  setPassword: {
    title: "Definir senha temporária",
    consequence:
      "A pessoa entra com esta senha e precisa trocá-la no primeiro acesso. As sessões abertas dela são encerradas. Informe a senha por um canal seguro.",
    confirm: "Salvar senha",
    done: "Senha definida. As sessões do usuário foram encerradas.",
  },
};

export function UserRowActions({
  userId,
  isActive,
  role,
  pendingInvite,
  disabled,
}: UserRowActionsProps) {
  const [isPending, startTransition] = useTransition();
  const [kind, setKind] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const router = useRouter();
  const uid = useId();
  const canManageCredentials = role === "operator" && !disabled;

  const open = (next: Kind) => {
    setKind(next);
    setError(null);
    setPasswordError(null);
    setMessage(null);
    setPassword("");
    setConfirm("");
  };

  const close = () => {
    if (isPending) return;
    setKind(null);
    setError(null);
    setPasswordError(null);
    setPassword("");
    setConfirm("");
  };

  const perform = (action: Kind) => {
    switch (action) {
      case "promote":
        return setUserRole({ userId, role: "bureau_admin" });
      case "deactivate":
        return setUserActive({ userId, isActive: false });
      case "activate":
        return setUserActive({ userId, isActive: true });
      case "forceChange":
        return setTeamMemberCredentials({ userId, password: undefined });
      case "setPassword":
        return setTeamMemberCredentials({ userId, password });
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!kind) return;
    if (kind === "setPassword") {
      const invalid = firstPasswordError(password, confirm);
      if (invalid) {
        setPasswordError(invalid);
        return;
      }
    }
    setError(null);
    setPasswordError(null);
    const current = kind;
    startTransition(async () => {
      const result = await perform(current);
      if (result.error) {
        setError(result.error);
        setPassword("");
        setConfirm("");
      } else {
        setMessage(COPY[current].done);
        setKind(null);
        setPassword("");
        setConfirm("");
      }
      router.refresh();
    });
  };

  const resend = () => {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await resendTeamInvite({ userId });
      if (result.error) setError(result.error);
      else setMessage("Convite reenviado. A pessoa recebe um novo link por e-mail.");
      router.refresh();
    });
  };

  const copy = kind ? COPY[kind] : null;

  return (
    <div className="flex flex-col gap-2 md:items-end">
      <div className="flex flex-wrap gap-2 md:justify-end">
        {pendingInvite && (
          <Button variant="outline" size="sm" disabled={isPending} onClick={resend}>
            Reenviar convite
          </Button>
        )}
        {role === "operator" && (
          <Button variant="outline" size="sm" disabled={disabled || isPending} onClick={() => open("promote")}>
            Tornar administrador
          </Button>
        )}
        {canManageCredentials && (
          <Button variant="outline" size="sm" disabled={isPending} onClick={() => open("setPassword")}>
            Definir senha
          </Button>
        )}
        {canManageCredentials && !pendingInvite && (
          <Button variant="outline" size="sm" disabled={isPending} onClick={() => open("forceChange")}>
            Forçar troca
          </Button>
        )}
        <Button
          variant={isActive ? "outline" : "secondary"}
          size="sm"
          disabled={disabled || isPending}
          onClick={() => open(isActive ? "deactivate" : "activate")}
        >
          {isActive ? "Desativar" : "Ativar"}
        </Button>
      </div>

      <Dialog
        open={kind !== null}
        onClose={close}
        title={copy?.title ?? ""}
        role={kind === "setPassword" ? "dialog" : "alertdialog"}
        dismissible={!isPending}
        className="[&_h2]:pr-12"
      >
        <form onSubmit={submit} className="space-y-4">
          <p className="text-base text-muted-foreground">{copy?.consequence}</p>
          {kind === "setPassword" && (
            <>
              <Field id={`${uid}-password`} label="Nova senha" error={passwordError}>
                {(a11y) => (
                  <PasswordInput {...a11y} value={password} onChange={(e) => setPassword(e.target.value)} />
                )}
              </Field>
              <Field id={`${uid}-confirm`} label="Confirmar senha">
                {(a11y) => (
                  <PasswordInput {...a11y} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                )}
              </Field>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm font-bold text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={isPending} onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" variant={copy?.destructive ? "destructive" : "default"} disabled={isPending}>
              {isPending ? "Salvando..." : copy?.confirm}
            </Button>
          </div>
        </form>
        <button
          type="button"
          aria-label="Fechar"
          onClick={close}
          disabled={isPending}
          className="absolute right-2 top-2 inline-flex size-11 items-center justify-center rounded-full text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <X aria-hidden className="size-5" />
        </button>
      </Dialog>

      {message && <StatusBanner tone="success" title={message} />}
      {error && kind === null && (
        <p role="alert" className="text-sm font-bold text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
