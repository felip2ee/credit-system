"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

// showModal() põe o <dialog> na top layer: um portal em document.body fica atrás dele e inerte. Todo primitivo flutuante
// monta o portal neste elemento. Fora de um Dialog o valor é null e o portal segue no body.
const DialogElementContext = React.createContext<HTMLDialogElement | null>(null);
export const useDialogElement = () => React.useContext(DialogElementContext);

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  // "alertdialog" para confirmações destrutivas.
  role?: "dialog" | "alertdialog";
  // false enquanto uma ação está em andamento: bloqueia Escape.
  dismissible?: boolean;
  className?: string;
  children: React.ReactNode;
}

// Modal sobre o <dialog> nativo: showModal() dá trap de foco, Escape, fundo inerte, bloqueio de scroll
// e devolve o foco ao elemento que abriu. O conteúdo só monta com o diálogo aberto (estado zera a cada abertura).
export function Dialog({
  open,
  onClose,
  title,
  description,
  role = "dialog",
  dismissible = true,
  className,
  children,
}: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  const openerRef = React.useRef<HTMLElement | null>(null);
  const [element, setElement] = React.useState<HTMLDialogElement | null>(null);

  React.useEffect(() => setElement(ref.current), []);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      // Navegador sem <dialog>.showModal (Safari antigo): não quebra, devolve o controle ao pai.
      if (typeof el.showModal !== "function") onClose();
      else {
        openerRef.current = document.activeElement as HTMLElement | null;
        el.showModal();
      }
    }
    if (!open && el.open) {
      el.close();
      // O conteúdo já desmontou: o navegador pode não devolver o foco sozinho.
      if (!document.activeElement || document.activeElement === document.body) openerRef.current?.focus();
    }
    // onClose fora das deps: só `open` deve ressincronizar o DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      // O Chrome ignora preventDefault num segundo Escape seguido e fecha o <dialog> sem o React saber.
      // Fechamento legítimo (open=false) já chega aqui com `open` falso; só o inesperado cai neste ramo.
      onClose={() => {
        if (!open) return;
        if (dismissible) onClose();
        else ref.current?.showModal();
      }}
      className={cn(
        "m-auto w-full max-w-md rounded-modal border border-border bg-card p-6 text-card-foreground shadow-lg backdrop:bg-background/80 motion-safe:animate-dialog-in",
        className,
      )}
    >
      {open && (
        <DialogElementContext.Provider value={element}>
          <div className="space-y-4">
            <h2 id={titleId} className="text-xl font-bold">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="text-muted-foreground">
                {description}
              </p>
            )}
            {children}
          </div>
        </DialogElementContext.Provider>
      )}
    </dialog>
  );
}
