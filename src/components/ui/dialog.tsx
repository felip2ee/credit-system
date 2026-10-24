"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
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
  role = "dialog",
  dismissible = true,
  className,
  children,
}: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      // Navegador sem <dialog>.showModal (Safari antigo): não quebra, devolve o controle ao pai.
      if (typeof el.showModal !== "function") onClose();
      else el.showModal();
    }
    if (!open && el.open) el.close();
    // onClose fora das deps: só `open` deve ressincronizar o DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={titleId}
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
        "m-auto w-full max-w-md rounded-lg border-2 bg-background p-6 text-foreground shadow-lg backdrop:bg-black/50",
        className,
      )}
    >
      {open && (
        <div className="space-y-4">
          <h2 id={titleId} className="text-xl font-bold">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
