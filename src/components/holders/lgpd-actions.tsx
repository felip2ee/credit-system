"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, EyeOff } from "lucide-react";

import { anonymizeClientAccountAction, anonymizeHolderAction } from "@/actions/lgpd";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MAX_REASON = 500;

interface AnonymizeDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  warning: string;
  submitLabel: string;
  run: (reason: string) => Promise<{ error: string | null }>;
}

function AnonymizeDialog({ open, onClose, title, warning, submitLabel, run }: AnonymizeDialogProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await run(reason);
      if (res.error) {
        setError(res.error);
        return;
      }
      setReason("");
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} role="alertdialog" dismissible={!isPending}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-muted-foreground">{warning}</p>
        <div className="space-y-2">
          <Label htmlFor="lgpd-reason">Motivo (mínimo 10 caracteres)</Label>
          <p id="lgpd-reason-hint" className="text-sm text-muted-foreground">
            Não inclua documento ou dados pessoais no motivo.
          </p>
          <Textarea
            id="lgpd-reason"
            rows={3}
            autoFocus
            maxLength={MAX_REASON}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isPending}
            aria-invalid={error !== null}
            aria-describedby={error ? "lgpd-reason-hint lgpd-error" : "lgpd-reason-hint"}
          />
        </div>
        {error && (
          <p id="lgpd-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            Voltar
          </Button>
          <Button type="submit" variant="destructive" disabled={isPending}>
            {isPending ? "Anonimizando..." : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface LgpdActionsProps {
  holderId: string;
  clientProfileId: string | null;
  anonymized: boolean;
}

export function LgpdActions({ holderId, clientProfileId, anonymized }: LgpdActionsProps) {
  const [dialog, setDialog] = useState<"holder" | "client" | null>(null);
  const close = () => setDialog(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>LGPD</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={`/api/lgpd/holders/${holderId}/export`} download>
            <Download className="h-4 w-4" />
            Exportar dados
          </a>
        </Button>
        {!anonymized && (
          <Button variant="outline" size="sm" onClick={() => setDialog("holder")}>
            <EyeOff className="h-4 w-4" />
            Anonimizar titular
          </Button>
        )}
        {clientProfileId && (
          <Button variant="outline" size="sm" onClick={() => setDialog("client")}>
            <EyeOff className="h-4 w-4" />
            Anonimizar conta do cliente
          </Button>
        )}
      </CardContent>
      <AnonymizeDialog
        open={dialog === "holder"}
        onClose={close}
        title="Anonimizar titular"
        warning="Os dados pessoais do titular e das consultas são apagados. Pedidos e pagamentos são mantidos. As autorizações SCR (prova do consentimento), a razão financeira e a auditoria ficam por 5 anos. Não há como desfazer."
        submitLabel="Anonimizar"
        run={(reason) => anonymizeHolderAction({ holderId, reason })}
      />
      {clientProfileId && (
        <AnonymizeDialog
          open={dialog === "client"}
          onClose={close}
          title="Anonimizar conta do cliente"
          warning="O acesso do cliente ao portal é encerrado e os dados da conta são apagados. A conta não pode ter saldo. Não há como desfazer."
          submitLabel="Anonimizar conta"
          run={(reason) => anonymizeClientAccountAction({ profileId: clientProfileId, reason })}
        />
      )}
    </Card>
  );
}
