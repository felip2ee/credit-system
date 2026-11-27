"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { updateOrderContactAction } from "@/actions/orders";
import { buildContactUpdate } from "@/components/dossiers/contact-rules";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface PendingContact {
  consultationId: string;
  name: string;
  role: string;
  // Sempre mascarado no servidor.
  maskedEmail: string | null;
}

interface ListProps {
  dossierId: string;
  contacts: PendingContact[];
  // Reenviar sem mudança só vale quando o pedido já espera a autorização (em awaiting_payment nada é enviado).
  canResend: boolean;
}

// Autorização pendente por membro: trocar o contato ou só reenviar o link.
export function OrderContactDialogList({ dossierId, contacts, canResend }: ListProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<PendingContact | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Contato salvo mas envio falhou: o tick reenvia sozinho; novo envio manual girava o link de novo.
  const [sendFailedIds, setSendFailedIds] = useState<ReadonlySet<string>>(new Set());

  const send = (contact: PendingContact, nextEmail: string, nextPhone: string, done: string) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await updateOrderContactAction(buildContactUpdate(dossierId, contact.consultationId, nextEmail, nextPhone));
      // Com id e erro, o contato foi salvo e só o envio falhou: fecha o formulário e atualiza a tela.
      const savedButNotSent = Boolean(res.error && res.id);
      if (res.error && !savedButNotSent) {
        setError(res.error);
        return;
      }
      if (savedButNotSent) setSendFailedIds((ids) => new Set(ids).add(contact.consultationId));
      setNotice(res.error ?? res.notice ?? done);
      setEditing(null);
      setEmail("");
      setPhone("");
      router.refresh();
    });
  };

  const close = () => {
    setEditing(null);
    setError(null);
  };

  return (
    <section aria-labelledby="pending-auth-title" className="space-y-2 rounded-md border p-3">
      <h3 id="pending-auth-title" className="text-sm font-medium">
        Autorizações pendentes
      </h3>
      <p className="text-sm text-muted-foreground">
        Trocar o contato invalida o link antigo.{canResend ? " Reenviar manda um link novo ao contato atual." : ""}
      </p>
      <ul className="space-y-2">
        {contacts.map((c) => (
          <li key={c.consultationId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0 break-words">
              <span className="font-medium">{c.name}</span> ({c.role})
              <span className="block text-muted-foreground">{c.maskedEmail ?? "Sem e-mail informado"}</span>
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending || sendFailedIds.has(c.consultationId)}
                onClick={() => {
                  setError(null);
                  setEditing(c);
                }}
              >
                Trocar e-mail/celular
              </Button>
              {canResend && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending || sendFailedIds.has(c.consultationId)}
                  onClick={() => send(c, "", "", `Autorização reenviada para ${c.name}.`)}
                >
                  Reenviar autorização
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div aria-live="polite">
        {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
        {error && !editing && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <Dialog open={editing !== null} onClose={close} title="Trocar e-mail/celular" dismissible={!isPending}>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (editing) send(editing, email, phone, `Contato atualizado e autorização reenviada para ${editing.name}.`);
          }}
        >
          <p className="text-sm text-muted-foreground">
            O link enviado ao e-mail antigo deixará de funcionar. Campo em branco mantém o dado atual.
          </p>
          <div className="space-y-2">
            <Label htmlFor="contact-email">Novo e-mail</Label>
            <Input
              id="contact-email"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-phone">Novo celular</Label>
            <Input
              id="contact-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={isPending}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={close} disabled={isPending}>
              Voltar
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Salvando..." : canResend ? "Salvar e reenviar" : "Salvar"}
            </Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
